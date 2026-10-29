// Смоук-тест цикла правки и приёма черновиков в очередь (T07, шаги 3–4).
// Оффлайн: вместо claude -p и Telegram — фейковые runner/боты. Запуск: node dispatcher/scripts/smoke-rework.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { isPublishable, platformForKind } from '../src/queue/kinds.js';
import { enqueueAgentResult } from '../src/queue/approval.js';
import { buildReworkTask, reworkDraft } from '../src/queue/rework.js';
import { parseSlotCommand } from '../src/queue/card.js';
import { dispatchPlan } from '../src/orchestrator.js';

// ── Что вообще идёт на согласование ───────────────────────────────────────
assert.equal(platformForKind('tg_post'), 'tg', 'пост Сценариста → Telegram');
assert.equal(platformForKind('carousel_spec'), 'ig', 'карусель Дизайнера → Instagram');
assert.equal(platformForKind('threads_post'), 'threads', 'текст → Threads');
assert.equal(platformForKind('producer_plan'), null, 'план Продюсера не согласовывают');
assert.equal(platformForKind('trend_report'), null, 'отчёт по трендам не согласовывают');
assert.equal(platformForKind('publish_check'), null, 'проверка Издателя не согласовывается сама с собой');
assert.equal(platformForKind(undefined), null, 'нет kind → нечего согласовывать');
assert.ok(isPublishable({ kind: 'tg_post' }) && !isPublishable({ kind: 'pdf_spec' }), 'pdf идёт своей веткой T13');

// ── Общий стенд: фейковый бот Издателя ────────────────────────────────────
const db = openDb(':memory:');
const cards = [];
const publisherEntry = {
  identity: { key: 'publisher', agent: 'publisher', topicId: 19 },
  bot: {
    api: {
      sendMessage: async (chatId, text, opts) => {
        cards.push({ chatId, text, opts });
        return { message_id: 900 + cards.length };
      },
    },
  },
};
const botsByKey = new Map([['publisher', publisherEntry]]);

// ── Приём ответа агента: публикуемое → карточка, остальное → мимо ─────────
const skipped = await enqueueAgentResult({
  db,
  agent: 'scout',
  meta: { kind: 'trend_report', title: 'Темы недели' },
  content: 'Тема 1…',
  botsByKey,
  groupId: -100123,
});
assert.equal(skipped.enqueued, false, 'отчёт по трендам в очередь не попал');
assert.equal(cards.length, 0, 'карточка не создавалась');

const taken = await enqueueAgentResult({
  db,
  agent: 'writer',
  meta: { kind: 'tg_post', title: 'Тариф' },
  content: '🚀 Первая версия',
  botsByKey,
  groupId: -100123,
});
assert.equal(taken.enqueued, true, 'пост встал в очередь');
assert.equal(db.queue.getById(taken.id).platform, 'tg', 'площадка выведена из kind');
assert.equal(cards[0].opts.message_thread_id, 19, 'карточка ушла в топик Издателя');

// ── Промпт доработки самодостаточен ───────────────────────────────────────
const prompt = buildReworkTask({ brief: 'Пост про тариф', previous: '🚀 Первая версия', note: 'Убрать эмодзи' });
assert.match(prompt, /ИСХОДНАЯ ЗАДАЧА/, 'исходная задача внутри');
assert.match(prompt, /Первая версия/, 'предыдущая версия внутри — агент её не помнит между вызовами');
assert.match(prompt, /Убрать эмодзи/, 'правка внутри');
assert.match(prompt, /полную новую версию целиком/, 'просим версию целиком, а не диф');
assert.ok(!buildReworkTask({ previous: 'x', note: 'y' }).includes('ИСХОДНАЯ ЗАДАЧА'), 'без задачи блок не пустует');

// ── Круг правки: новая версия в очереди, старая — superseded ──────────────
db.queue.decide(taken.id, 'needs_edit', { by: '@owner', note: 'Убрать эмодзи' });
const reworked = await reworkDraft({
  db,
  item: db.queue.getById(taken.id),
  note: 'Убрать эмодзи',
  publisherBot: publisherEntry.bot,
  groupId: -100123,
  topicId: 19,
  runner: async ({ agentKey, task }) => {
    assert.equal(agentKey, 'writer', 'на доработку зовут автора черновика');
    assert.match(task, /Убрать эмодзи/, 'агент получил правку');
    return { ok: true, content: 'Вторая версия без эмодзи', meta: { kind: 'tg_post' } };
  },
});
assert.equal(reworked.ok, true, 'доработка прошла');
const v2 = db.queue.getById(reworked.id);
assert.equal(v2.status, 'pending', 'новая версия ждёт решения');
assert.equal(v2.parent_id, taken.id, 'новая версия помнит предка');
assert.equal(v2.edit_note, 'Убрать эмодзи', 'правка сохранена у новой версии');
assert.equal(db.queue.getById(taken.id).status, 'superseded', 'старая версия ушла из очереди');
assert.equal(db.queue.listPending().length, 1, 'в ленте согласования одна карточка, а не две');
assert.match(cards.at(-1).text, /Версия после правки #1/, 'на карточке видно, что это правка');

// Агент упал на доработке → элемент остаётся на правке, попытку можно повторить.
const failed = await reworkDraft({
  db,
  item: v2,
  note: 'Ещё короче',
  publisherBot: publisherEntry.bot,
  groupId: -100123,
  topicId: 19,
  runner: async () => ({ ok: false, error: 'claude -p: timeout' }),
});
assert.equal(failed.ok, false, 'провал доработки виден вызывающему');
assert.match(failed.error, /timeout/, 'причина названа');
assert.equal(db.queue.getById(v2.id).status, 'pending', 'исходная версия не потеряна');

// ── Раздача Продюсера кладёт черновик исполнителя в очередь (T05 → T07) ───
const dispatchDb = openDb(':memory:');
const writerEntry = { identity: { key: 'writer', agent: 'writer', topicId: 2 }, bot: { name: 'writerBot' } };
const results = await dispatchPlan({
  tasks: [{ agent: 'writer', brief: 'Пост про тариф' }],
  goal: 'Тариф',
  db: dispatchDb,
  groupId: -100123,
  botsByKey: new Map([
    ['producer', { identity: { key: 'producer', agent: 'producer', topicId: 14 }, bot: { name: 'producerBot' } }],
    ['writer', writerEntry],
    ['publisher', publisherEntry],
  ]),
  poster: async () => {},
  runner: async () => ({ ok: true, content: 'Готовый пост', meta: { kind: 'tg_post', title: 'Тариф' } }),
});
assert.equal(results[0].status, 'done', 'задача выполнена');
assert.ok(results[0].queueId, 'черновик исполнителя автоматически ушёл на согласование');
assert.equal(dispatchDb.queue.getById(results[0].queueId).task_id, results[0].id, 'элемент очереди помнит задачу');
dispatchDb.close();

// ── Слот контент-календаря ────────────────────────────────────────────────
assert.deepEqual(
  parseSlotCommand('/слот 12 2026-09-05 10:00'),
  { id: 12, slotAt: '2026-09-05 10:00', recognized: true },
  'команда слота с распознанным временем',
);
assert.deepEqual(
  parseSlotCommand('slot #7 завтра в 10'),
  { id: 7, slotAt: 'завтра в 10', recognized: false },
  'решётка и произвольное время: сохраняем, но расписанием не считаем',
);
assert.equal(parseSlotCommand('/слот 12'), null, 'без времени — не команда');
assert.equal(parseSlotCommand('слоты кончились'), null, 'обычный текст не перехватывается');
db.queue.setSlot(v2.id, '2026-09-05 10:00');
assert.equal(db.queue.getById(v2.id).slot_at, '2026-09-05 10:00', 'слот сохранён у элемента очереди');

db.close();
console.log('✓ smoke-rework PASS — правка делает новую версию, публикуемое само идёт в очередь');
