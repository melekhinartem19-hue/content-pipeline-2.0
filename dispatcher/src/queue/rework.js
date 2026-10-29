// Цикл правки (T07): «✏️ Правка» → комментарий владельца реплаем → агент-автор переделывает
// черновик через `claude -p` → новая версия встаёт в очередь новой карточкой.
//
// Почему реплаем, а не отдельной командой: карточка уже висит в топике Издателя, реплай на неё
// однозначно связывает правку с элементом очереди — не нужно просить владельца вводить номер.
// Связь «сообщение ↔ элемент» лежит в БД (card_chat_id/card_message_id), поэтому цикл переживает
// перезапуск процесса.
//
// История версий не теряется: новая версия помнит parent_id и текст правки, старая уходит в
// superseded (из очереди пропадает, из БД — нет).

import { runAgent } from '../agent.js';
import { enqueueDraft } from './approval.js';
import { VIDEO_KIND } from '../video/ingest.js';

/**
 * Промпт доработки. Чистая функция — проверяется оффлайн.
 * Агент за один проход не помнит прошлый ответ (каждый вызов `claude -p` независим),
 * поэтому предыдущую версию и исходную задачу кладём в текст явно.
 */
export function buildReworkTask({ brief = null, previous, note }) {
  return [
    'Доработай СВОЙ предыдущий черновик по правке владельца.',
    'Верни полную новую версию целиком (не список изменений, не диф), в своём обычном формате.',
    '',
    ...(brief ? ['════ ИСХОДНАЯ ЗАДАЧА ════', brief.trim(), ''] : []),
    '════ ПРЕДЫДУЩАЯ ВЕРСИЯ ════',
    String(previous || '').trim(),
    '',
    '════ ПРАВКА ВЛАДЕЛЬЦА ════',
    String(note || '').trim(),
  ].join('\n');
}

/**
 * Прогоняет один круг доработки и ставит новую версию в очередь.
 * @param {object} o
 * @param {object} o.db  фасад БД
 * @param {object} o.item  элемент очереди, который правим (status = needs_edit)
 * @param {string} o.note  текст правки от владельца
 * @param {object} o.publisherBot  бот Издателя (его карточка → он же её и редактирует)
 * @param {number|string} o.groupId
 * @param {number} o.topicId  топик Издателя
 * @param {Function} [o.runner]  инъекция для тестов (default: runAgent)
 * @returns {Promise<{ok:boolean, id?:number, error?:string}>}
 */
export async function reworkDraft({ db, item, note, publisherBot, groupId, topicId, runner = runAgent }) {
  // Ролик правится монтажом, а монтаж живёт на ноуте клиента (T15): на VPS нет ни исходников,
  // ни агента-видео. Зовём claude -p впустую — только сожжём вызов и получим невнятный ответ,
  // поэтому честно говорим владельцу, что делать. Элемент остаётся needs_edit: новая версия
  // приедет отдельным заливом с ноута.
  if (item.kind === VIDEO_KIND) {
    return {
      ok: false,
      error:
        'это готовый ролик, а не текст: на VPS его перемонтировать нечем. Правка записана — ' +
        'перемонтируй на ноуте и залей заново (ingest:video), приедет новая карточка',
    };
  }

  const task = db.tasks.getById(item.task_id) ?? null;
  const prompt = buildReworkTask({ brief: task?.brief ?? item.title, previous: item.content, note });

  const res = await runner({ agentKey: item.agent, task: prompt });
  if (!res.ok) {
    // Правка не удалась — элемент остаётся needs_edit, чтобы попытку можно было повторить.
    return { ok: false, error: res.error || 'агент не вернул результат' };
  }

  const content = res.content?.trim() || '(пустой ответ агента)';
  const { id } = await enqueueDraft({
    db,
    bot: publisherBot,
    groupId,
    topicId,
    draft: {
      platform: item.platform,
      agent: item.agent,
      kind: item.kind,
      title: item.title,
      content,
      meta: res.meta ?? null,
      taskId: item.task_id ?? null,
      parentId: item.id,
      editNote: note,
    },
  });

  // Родителя убираем из очереди только после того, как новая версия реально встала.
  db.queue.markSuperseded(item.id);
  return { ok: true, id };
}
