// Оркестрация плана Продюсера (T05): разложить задачи по топикам агентов и исполнить их.
//
// ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ «БОТ ПИШЕТ БОТУ»:
// Telegram НЕ доставляет ботам сообщения других ботов. ТЗ, которое Продюсер постит в топик
// Сценариста, сам Сценарист-бот не увидит — его хендлер не сработает. Поэтому цепочку замыкает
// диспетчер: он один процесс, внутри которого живут все 6 бот-идентичностей, и он вызывает
// агента-исполнителя напрямую через контракт runAgent (claude -p), а результат постит в топик
// исполнителя ОТ ИМЕНИ его бота. Снаружи это выглядит как живой конвейер.
//
// Поток одной задачи:
//   producer_plan.tasks[] → tasks(queued) в БД → ТЗ в топик исполнителя (от Продюсера)
//   → runAgent(исполнитель) → tasks(running→done|failed) → черновик в топик (от бота-исполнителя)
//
// Диспетчер остаётся «тупой трубой»: здесь только маршрутизация, состояние и I/O — интеллект весь
// в claude -p.

import { runAgent } from './agent.js';
import { postToTopic } from './bots/send.js';
import { enqueueAgentResult } from './queue/approval.js';

/** Больше задач за один план не берём: каждая — тяжёлый вызов claude -p. Хвост честно отбрасываем. */
export const MAX_TASKS_PER_PLAN = 6;

/** Сколько символов ответа исполнителя кладём в БД как выжимку (полный текст уходит в топик). */
const RESULT_EXCERPT_LIMIT = 300;

const STATUS_ICON = { queued: '⏳', running: '⚙️', done: '✅', failed: '⚠️' };

/**
 * Достаёт задачи из META-конверта Продюсера и отсеивает мусор.
 * Ответ агента — текст от языковой модели, поэтому здесь ему НЕ доверяем: проверяем, что агент
 * существует среди поднятых ботов, что ТЗ непустое, и режем длину плана.
 * @param {object} meta  распарсенный META-конверт (см. agent.js)
 * @param {Set<string>|string[]} knownAgents  ключи агентов, которым реально можно ставить задачи
 * @returns {{tasks: {agent:string, brief:string}[], skipped: {agent:string, reason:string}[]}}
 */
export function extractTasks(meta, knownAgents) {
  const known = knownAgents instanceof Set ? knownAgents : new Set(knownAgents);
  const raw = Array.isArray(meta?.tasks) ? meta.tasks : [];
  const tasks = [];
  const skipped = [];

  for (const t of raw) {
    const agent = typeof t?.agent === 'string' ? t.agent.trim().toLowerCase() : '';
    const brief = typeof t?.brief === 'string' ? t.brief.trim() : '';
    if (!known.has(agent)) {
      skipped.push({ agent: agent || '(не указан)', reason: 'нет такого агента среди поднятых ботов' });
      continue;
    }
    if (!brief) {
      skipped.push({ agent, reason: 'пустое ТЗ' });
      continue;
    }
    if (tasks.length >= MAX_TASKS_PER_PLAN) {
      skipped.push({ agent, reason: `сверх лимита ${MAX_TASKS_PER_PLAN} задач на план` });
      continue;
    }
    tasks.push({ agent, brief });
  }
  return { tasks, skipped };
}

// Глобальная очередь исполнения: claude -p тяжёлый, параллельные планы гоняем последовательно.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {}); // падение одной задачи не рвёт очередь
  return next;
}

/**
 * Раздаёт задачи по топикам и последовательно их исполняет.
 * @param {object} o
 * @param {{agent:string, brief:string}[]} o.tasks  уже отфильтрованные задачи (см. extractTasks)
 * @param {string|null} o.goal  цель плана (title из META Продюсера)
 * @param {object} o.db  фасад БД (нужен db.tasks)
 * @param {number|string} o.groupId  id форум-группы
 * @param {Map<string,{bot:object, identity:object}>} o.botsByKey  поднятые боты по ключу агента
 * @param {string} [o.producerKey]  от чьего имени постить ТЗ (по умолчанию producer)
 * @param {Function} [o.runner]  инъекция для тестов (default: runAgent)
 * @param {Function} [o.poster]  инъекция для тестов (default: postToTopic)
 * @param {Function} [o.enqueuer]  инъекция для тестов (default: enqueueAgentResult)
 * @returns {Promise<{id:number, agent:string, status:string, queueId?:number, error?:string}[]>}
 */
export async function dispatchPlan({
  tasks,
  goal = null,
  db,
  groupId,
  botsByKey,
  producerKey = 'producer',
  runner = runAgent,
  poster = postToTopic,
  enqueuer = enqueueAgentResult,
}) {
  const producerBot = botsByKey.get(producerKey)?.bot;
  const results = [];

  for (const { agent, brief } of tasks) {
    const target = botsByKey.get(agent);
    const topicId = target?.identity?.topicId ?? null;
    const id = db.tasks.add({ agent, brief, goal, topicId });

    // Исполнитель поднят, но топик ему не задан в .env → раздавать некуда, честно фиксируем провал.
    if (!target || topicId == null) {
      const error = `у агента «${agent}» не задан топик (TOPIC_${agent.toUpperCase()} в .env)`;
      db.tasks.markFailed(id, error);
      results.push({ id, agent, status: 'failed', error });
      continue;
    }

    // 1) ТЗ в топик исполнителя — от имени Продюсера (человеку видно, кто и что поставил).
    try {
      const header = goal ? `📌 Задача #${id} от Продюсера · ${goal}` : `📌 Задача #${id} от Продюсера`;
      await poster(producerBot, groupId, topicId, `${header}\n\n${brief}`);
    } catch (err) {
      const error = `не удалось запостить ТЗ в топик: ${err.message}`;
      db.tasks.markFailed(id, error);
      results.push({ id, agent, status: 'failed', error });
      continue;
    }

    // 2) Исполнение: зовём агента напрямую (бот бота не слышит — см. шапку файла).
    const outcome = await serial(async () => {
      db.tasks.markRunning(id);
      try {
        const res = await runner({ agentKey: agent, task: brief });
        if (!res.ok) throw new Error(res.error || 'агент не вернул результат');
        const content = res.content?.trim() || '(пустой ответ агента)';
        await poster(target.bot, groupId, topicId, `✅ Готово по задаче #${id}\n\n${content}`);
        db.tasks.markDone(id, content.slice(0, RESULT_EXCERPT_LIMIT));

        // Публикуемый черновик сразу уходит на согласование карточкой в топик Издателя (T07).
        // Непубликуемое (отчёт по трендам и т.п.) остаётся только в топике автора.
        // Для Дизайнера постановка в очередь включает рендер визуала (T10): картинки уходят
        // в его топик и в топик Издателя, а пути к ним — в meta элемента очереди.
        const queued = await enqueuer({ db, agent, meta: res.meta, content, taskId: id, botsByKey, groupId });
        return {
          id,
          agent,
          status: 'done',
          queueId: queued.enqueued ? queued.id : undefined,
          images: queued.images?.length || 0,
          visualError: queued.visualError || null,
        };
      } catch (err) {
        db.tasks.markFailed(id, err.message);
        await poster(target.bot, groupId, topicId, `⚠️ Задача #${id} не выполнена: ${err.message}`).catch(() => {});
        return { id, agent, status: 'failed', error: err.message };
      }
    });
    results.push(outcome);
  }

  return results;
}

/** Короткая сводка раздачи — её Продюсер досылает в свой топик сразу после плана. */
export function renderDispatchSummary(results, skipped = []) {
  if (!results.length && !skipped.length) return null;
  const lines = ['📤 Раздача задач:'];
  for (const r of results) {
    const pics = r.images ? ` 🖼${r.images}` : '';
    const tail = r.error ? ` — ${r.error}` : r.queueId ? ` → на согласование #${r.queueId}${pics}` : '';
    lines.push(`${STATUS_ICON[r.status] || '•'} #${r.id} → ${r.agent}${tail}`);
    // Рендер визуала мог не удаться, хотя сама задача выполнена — это разные новости.
    if (r.visualError) lines.push(`   ⚠️ визуал: ${r.visualError}`);
  }
  for (const s of skipped) {
    lines.push(`⚠️ пропущено → ${s.agent} — ${s.reason}`);
  }
  return lines.join('\n');
}

/**
 * Текст команды «/статус» в топике Продюсера: что роздано и в каком состоянии.
 * Статусы помнит диспетчер, а не агент: у агента один проход claude -p без доступа к БД.
 */
export function renderStatus(db, { limit = 15 } = {}) {
  const rows = db.tasks.list({ limit });
  if (!rows.length) return '📋 Задач пока нет — поставь цель, и я разложу её по агентам.';

  const counts = db.tasks.countsByStatus();
  const head = Object.entries(counts)
    .map(([status, n]) => `${STATUS_ICON[status] || '•'} ${status}: ${n}`)
    .join(' · ');

  const lines = [`📋 Статус задач (${head})`, ''];
  for (const r of rows) {
    const icon = STATUS_ICON[r.status] || '•';
    const tail = r.status === 'failed' ? ` — ${r.error}` : '';
    lines.push(`${icon} #${r.id} → ${r.agent}: ${firstLine(r.brief)}${tail}`);
  }
  return lines.join('\n');
}

function firstLine(text, max = 80) {
  const line = String(text || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Распознаёт запрос статуса («/статус», «/status», «статус»), чтобы не гонять его через claude -p. */
export function isStatusCommand(text) {
  // Граница слова — через (?![\p{L}\p{N}_]) с флагом u: \b кириллицу за букву не считает,
  // из-за чего «статус» в конце строки не матчился бы вовсе.
  return /^\/?(статус|status)(?![\p{L}\p{N}_])/iu.test(String(text || '').trim());
}
