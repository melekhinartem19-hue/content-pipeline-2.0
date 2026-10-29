// Мост «темы воронки → три PDF в статике» (T13).
//
// Здесь диспетчер соединяет четыре своих мира: конфиг воронки (manychat/funnel.json), агента
// Презентатора (`claude -p`), модуль render/ (структура → PDF) и публичную статику Nginx, по
// ссылкам которой ManyChat потом раздаёт файлы (T14). Всё телеграмное и все решения «куда класть»
// живут в этом файле — render/ остаётся переносимым, а конфиг воронки чистыми данными.
//
//   тема → claude -p (Презентатор) → PDF → копия в PUBLIC_DIR → ссылка в БД → файл в топик
//
// ПОЧЕМУ БЕЗ ОЧЕРЕДИ СОГЛАСОВАНИЯ. Через очередь (T07) идёт то, что публикуется в ленту, и там
// решение владельца — «постить или нет». Лид-магнит в ленту не уходит: он лежит в статике и
// отдаётся по запросу в директе. Поэтому `pdf_spec` в очередь не попадает (см. queue/kinds.js),
// а владелец смотрит готовый файл прямо в топике Презентатора и при желании пересобирает тему.
//
// ПРАВИЛО «ОДНА ТЕМА НЕ РОНЯЕТ ОСТАЛЬНЫЕ». Каждая тема — это отдельный вызов claude (деньги и
// время) плюс отдельный рендер. Сбой на одной теме не отменяет две другие: ошибка запоминается
// в результатах и печатается в отчёте, цикл идёт дальше.

import path from 'node:path';
import { InputFile } from 'grammy';
import { renderPdf } from '../../../render/pdf.js';
import { runAgent } from '../agent.js';
import { mediaReady, publishFiles } from '../publish/media.js';
import { findTopic, loadFunnel, pdfFileName, topicTask } from './config.js';

/** Ключ агента, который проектирует структуру документа. */
export const PRESENTER_AGENT = 'presenter';

/** Лимит подписи к документу в Telegram. */
const CAPTION_LIMIT = 1024;

/**
 * Разбирает «/пдф», «/пдф content-plan», «/пдф список» → что делать.
 * Список отдельной командой не сделан нарочно: у Презентатора одна тема разговора — его PDF,
 * и «/пдф список» читается как вопрос к той же команде, а не как новая сущность.
 * @returns {{all:boolean, list:boolean, key:string|null}|null} null, если это не команда
 */
export function parsePdfCommand(text) {
  const m = /^\/?(пдф|pdf|презентации|лид-?магниты)(?:\s+([\wа-яё-]+))?\s*$/iu.exec(String(text || '').trim());
  if (!m) return null;
  const arg = (m[2] || '').trim().toLowerCase();
  if (arg === 'список' || arg === 'list' || arg === 'ссылки') return { all: false, list: true, key: null };
  if (!arg || arg === 'all' || arg === 'все' || arg === 'всё') return { all: true, list: false, key: null };
  return { all: false, list: false, key: arg };
}

/**
 * Собирает PDF по темам воронки: агент → рендер → статика → БД → топик Презентатора.
 *
 * @param {object} o
 * @param {object} o.db  фасад БД (нужен db.funnel)
 * @param {object} o.config  конфиг диспетчера (пути, публичная статика, brand-brain)
 * @param {Map<string,{bot:object, identity:object}>} [o.botsByKey]  поднятые боты
 * @param {number|string|null} [o.groupId]  форум-группа
 * @param {string} [o.presenterKey]  ключ бота-Презентатора
 * @param {string|null} [o.key]  собрать только одну тему (её ключ); null — все
 * @param {Function} [o.agentRunner]  инъекция для тестов (default: runAgent)
 * @param {Function} [o.renderer]  инъекция для тестов (default: renderPdf)
 * @param {Function} [o.onLog]
 * @returns {Promise<{ok:boolean, results:object[], note:string|null, error:string|null}>}
 */
export async function buildFunnelPdfs({
  db,
  config,
  botsByKey = null,
  groupId = null,
  presenterKey = PRESENTER_AGENT,
  key = null,
  agentRunner = runAgent,
  renderer = renderPdf,
  onLog = () => {},
}) {
  const funnel = loadFunnel(config.funnelConfigPath);
  if (!funnel.ok) return { ok: false, results: [], note: null, error: funnel.error };

  let topics = funnel.topics;
  if (key) {
    const one = findTopic(topics, key);
    if (!one) {
      return {
        ok: false,
        results: [],
        note: null,
        error: `темы «${key}» нет в manychat/funnel.json (есть: ${topics.map((t) => t.key).join(', ')})`,
      };
    }
    topics = [one];
  }

  // Статику проверяем ОДИН раз и до вызовов агента: если публичной папки нет, файлы всё равно
  // соберутся и лягут локально, но ссылок не будет — про это честнее сказать сразу.
  const media = mediaReady(config);

  const seat = botsByKey?.get(presenterKey);
  const results = [];

  for (const topic of topics) {
    onLog(`[funnel] тема «${topic.key}»: зову Презентатора…`);
    const result = { key: topic.key, title: topic.title, ok: false };

    const agent = await agentRunner({ agentKey: PRESENTER_AGENT, task: topicTask(topic) });
    if (!agent.ok) {
      result.error = `агент не ответил: ${agent.error}`;
      results.push(result);
      continue;
    }

    const outFile = path.join(config.pdfsDir, pdfFileName(topic));
    onLog(`[funnel] тема «${topic.key}»: собираю PDF…`);
    let render;
    try {
      render = await renderer({
        content: agent.content,
        outFile,
        brandBrainDir: config.brandBrainDir,
        title: topic.title,
      });
    } catch (err) {
      // Браузер не стартовал, нет прав на папку — остальные темы это не отменяет.
      result.error = `рендер упал: ${err.message}`;
      results.push(result);
      continue;
    }

    if (!render.ok) {
      result.error = `PDF не собрался: ${render.error}`;
      results.push(result);
      continue;
    }

    result.ok = true;
    result.file = render.file;
    result.pages = render.pages;
    result.note = render.note;

    // Публичная ссылка. Без неё PDF есть, но воронке его отдать нечем — это предупреждение,
    // а не провал сборки: настройка статики делается на деплое, а темы собирают и до него.
    if (media.ok) {
      try {
        const { urls } = publishFiles({ files: [render.file], config, subdir: config.pdfPublicSubdir });
        result.url = urls[0];
      } catch (err) {
        result.warn = `в публичную папку не скопировался: ${err.message}`;
      }
    } else {
      result.warn = media.error;
    }

    db.funnel.upsert({
      key: topic.key,
      title: topic.title,
      file: render.file,
      url: result.url || null,
      pages: render.pages,
      meta: { note: render.note, truncated: render.truncated, agentMeta: agent.meta || null },
    });

    // Готовый файл — в топик Презентатора: владелец смотрит документ, а не описание документа.
    if (seat?.bot && groupId && seat.identity?.topicId != null) {
      try {
        await postDocument(seat.bot, groupId, seat.identity.topicId, render.file, documentCaption(topic, result));
      } catch (err) {
        result.warn = [result.warn, `в топик не отправился: ${err.message}`].filter(Boolean).join(' · ');
      }
    } else if (botsByKey) {
      // Бот или топик Презентатора не подняты — файл собран, но человек его не увидит.
      // Говорим об этом и подсказываем, где он лежит: молча «собрать в никуда» хуже всего.
      result.warn = [result.warn, `в топик не ушёл (нет бота или TOPIC_PRESENTER) — файл в ${render.file}`]
        .filter(Boolean)
        .join(' · ');
    }

    results.push(result);
  }

  return { ok: results.some((r) => r.ok), results, note: funnel.note || null, error: null };
}

/** Подпись под документом в топике: тема, объём и ссылка (если статика настроена). */
export function documentCaption(topic, result) {
  const lines = [`📄 ${topic.title}`, `Тема воронки: ${topic.key} · ${result.note || `страниц: ${result.pages}`}`];
  if (result.url) lines.push(`Ссылка для воронки: ${result.url}`);
  return lines.join('\n').slice(0, CAPTION_LIMIT);
}

/**
 * Отчёт о сборке для топика: что собралось, по каким ссылкам и что настроить, если ссылок нет.
 * Чистая функция — её проверяет смоук, а не живой прогон.
 */
export function renderPdfReport({ results, note = null, error = null }) {
  if (error) return `⚠️ Сборка PDF не пошла: ${error}`;
  if (!results.length) return '⚠️ Собирать нечего: в конфиге воронки нет тем.';

  const lines = ['📄 PDF инста-воронки:'];
  for (const r of results) {
    if (!r.ok) {
      lines.push(`  ⚠️ ${r.title} (${r.key}) — ${r.error}`);
      continue;
    }
    lines.push(`  ✅ ${r.title} (${r.key}) — страниц: ${r.pages}`);
    if (r.url) lines.push(`     ${r.url}`);
    if (r.warn) lines.push(`     ⚠️ ${r.warn}`);
  }

  const ok = results.filter((r) => r.ok).length;
  lines.push(`Итого собрано: ${ok} из ${results.length}.`);
  if (note) lines.push(`ℹ️ ${note}`);
  if (results.some((r) => r.ok && !r.url)) {
    lines.push(
      'ℹ️ Публичных ссылок нет: задай PUBLIC_DIR и PUBLIC_BASE_URL в .env — без них воронке ' +
        'нечего отдать в директ (файл-PDF в Instagram отправить нельзя, только ссылку).',
    );
  }
  return lines.join('\n');
}

/** Что сейчас отдаёт воронка: строки из БД, без пересборки и без вызовов агента. */
export function renderFunnelList(rows) {
  if (!rows.length) return '📄 PDF воронки ещё не собраны. Команда сборки — «/пдф».';
  const lines = ['📄 PDF воронки:'];
  for (const row of rows) {
    lines.push(`  • ${row.title} (${row.key}) — страниц: ${row.pages ?? '?'} · собран ${row.built_at}`);
    lines.push(`     ${row.url || 'ссылки нет (не настроена публичная статика)'}`);
  }
  return lines.join('\n');
}

/** Отправляет готовый PDF документом в топик. */
export async function postDocument(bot, chatId, threadId, file, caption = '') {
  return bot.api.sendDocument(chatId, new InputFile(file), {
    message_thread_id: threadId,
    caption: caption.slice(0, CAPTION_LIMIT),
  });
}
