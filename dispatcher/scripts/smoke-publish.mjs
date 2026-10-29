// Смоук-тест публикации в TG-канал (T08): только одобренное, текст+фото, слот, статусы.
// Оффлайн: вместо канала — фейковый bot.api. Запуск: node dispatcher/scripts/smoke-publish.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { publishToTelegram, pickPhoto, CAPTION_LIMIT } from '../src/publish/telegram.js';
import { isFutureSlot, nowStamp, publishItem } from '../src/publish/index.js';
import { startPublishScheduler } from '../src/publish/scheduler.js';
import { normalizeSlot, parseSlotCommand } from '../src/queue/card.js';

const db = openDb(':memory:');
assert.ok(db.appliedMigrations.includes('004_publish'), 'миграция 004_publish должна примениться');

// ── Фейковый канал ────────────────────────────────────────────────────────
const posted = [];
const makeBot = (fail = false) => ({
  api: {
    sendMessage: async (chat, text) => {
      if (fail) throw new Error('Forbidden: bot is not a member of the channel chat');
      posted.push({ kind: 'text', chat, text });
      return { message_id: 100 + posted.length };
    },
    sendPhoto: async (chat, photo, opts = {}) => {
      posted.push({ kind: 'photo', chat, photo, caption: opts.caption ?? null });
      return { message_id: 100 + posted.length };
    },
  },
});
const seat = (bot) => new Map([['publisher', { bot, identity: { key: 'publisher', topicId: 19 } }]]);

// ── Отправка: текст, фото с подписью, длинный текст ───────────────────────
const bot = makeBot();
await publishToTelegram({ bot, channelId: '@test', text: 'Просто пост' });
assert.equal(posted.at(-1).kind, 'text', 'без фото — обычное сообщение');

await publishToTelegram({ bot, channelId: '@test', text: 'Короткий', photo: 'https://example.com/a.jpg' });
assert.equal(posted.at(-1).kind, 'photo', 'с фото — sendPhoto');
assert.equal(posted.at(-1).caption, 'Короткий', 'короткий текст ушёл подписью');

posted.length = 0;
await publishToTelegram({ bot, channelId: '@test', text: 'я'.repeat(CAPTION_LIMIT + 50), photo: 'https://example.com/a.jpg' });
assert.equal(posted[0].kind, 'photo', 'сперва фото');
assert.equal(posted[0].caption, null, 'подписи нет — текст не влез в лимит 1024');
assert.equal(posted[1].kind, 'text', 'текст ушёл отдельным сообщением');

posted.length = 0;
await publishToTelegram({ bot, channelId: '@test', text: 'a'.repeat(5000) });
assert.equal(posted.length, 2, 'длинный текст порезан под лимит 4096');

assert.equal(pickPhoto({ photo_url: ' https://x/y.png ' }), 'https://x/y.png', 'фото берётся из META');
assert.equal(pickPhoto({}), null, 'нет картинки — текстовый пост');

// ── В канал уходит ТОЛЬКО одобренное ──────────────────────────────────────
const draft = (status, extra = {}) =>
  db.queue.getById(db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'Текст', status, ...extra }));

for (const status of ['pending', 'rejected', 'needs_edit', 'superseded', 'published']) {
  const item = draft(status);
  const res = await publishItem({ db, item, botsByKey: seat(makeBot()), channelId: '@test' });
  assert.equal(res.status, 'skipped', `${status} публиковать нельзя`);
  assert.match(res.reason, /публиковать нельзя/, 'причина названа');
}

// ── Одобренное публикуется и меняет статус ────────────────────────────────
posted.length = 0;
const okBot = makeBot();
const approved = draft('approved');
const okRes = await publishItem({ db, item: approved, botsByKey: seat(okBot), channelId: '@test' });
assert.equal(okRes.status, 'published', 'одобренное ушло в канал');
assert.equal(posted.length, 1, 'в канал отправлено одно сообщение');
const stored = db.queue.getById(approved.id);
assert.equal(stored.status, 'published', 'статус в БД — published');
assert.ok(stored.published_message_id, 'id сообщения в канале сохранён');
assert.ok(stored.published_at, 'время публикации проставлено');

// ── Ошибка канала: статус publish_failed + причина ────────────────────────
const failing = draft('approved');
const failRes = await publishItem({ db, item: failing, botsByKey: seat(makeBot(true)), channelId: '@test' });
assert.equal(failRes.status, 'failed', 'ошибка отправки видна вызывающему');
assert.match(db.queue.getById(failing.id).publish_error, /not a member/, 'причина сохранена в БД');
assert.equal(db.queue.getById(failing.id).status, 'publish_failed', 'элемент помечен как непроубликованный');
// Из publish_failed можно повторить попытку — статус это разрешает.
const retry = await publishItem({ db, item: db.queue.getById(failing.id), botsByKey: seat(makeBot()), channelId: '@test' });
assert.equal(retry.status, 'published', 'повторная попытка проходит');

// Канал не настроен → честная ошибка, а не тихое «ок».
const noChannel = await publishItem({ db, item: draft('approved'), botsByKey: seat(makeBot()), channelId: null });
assert.equal(noChannel.status, 'failed', 'без TG_CHANNEL_ID публикации нет');
assert.match(noChannel.error, /TG_CHANNEL_ID/, 'сказано, чего не хватает');

// IG идёт своим путём (T12): без кредов Meta — честная ошибка настройки, а не тишина.
const igItem = db.queue.getById(db.queue.add({ platform: 'ig', agent: 'designer', kind: 'carousel_spec', content: 'x', status: 'approved' }));
const ig = await publishItem({ db, item: igItem, botsByKey: seat(makeBot()), channelId: '@test', config: {} });
assert.equal(ig.status, 'failed', 'без кредов Meta публикации в IG нет');
assert.match(ig.error, /IG_USER_ID/, 'сказано, чего именно не хватает');

// Несуществующая площадка — не крэш, а внятный отказ.
const alien = db.queue.getById(db.queue.add({ platform: 'vk', agent: 'writer', kind: 'tg_post', content: 'x', status: 'approved' }));
const alienRes = await publishItem({ db, item: alien, botsByKey: seat(makeBot()), channelId: '@test' });
assert.equal(alienRes.status, 'skipped', 'неизвестная площадка не публикуется');

// ── Слот контент-календаря ────────────────────────────────────────────────
assert.equal(normalizeSlot('2026-09-05T10:00:00'), '2026-09-05 10:00', 'ISO приводится к единому виду');
assert.equal(normalizeSlot('завтра в 10'), null, 'свободный текст не расписание');
assert.equal(parseSlotCommand('/слот 3 завтра в 10').recognized, false, 'нераспознанный слот помечен');
assert.ok(isFutureSlot('2099-01-01 10:00'), 'будущее — расписание');
assert.ok(!isFutureSlot('2000-01-01 10:00'), 'прошлое публикуем сразу');
assert.ok(!isFutureSlot('завтра в 10'), 'свободный текст не откладывает публикацию');

posted.length = 0;
const future = draft('approved', {});
db.queue.setSlot(future.id, '2099-01-01 10:00');
const scheduled = await publishItem({ db, item: db.queue.getById(future.id), botsByKey: seat(makeBot()), channelId: '@test' });
assert.equal(scheduled.status, 'scheduled', 'слот на будущее откладывает публикацию');
assert.equal(posted.length, 0, 'в канал ничего не ушло');
assert.equal(db.queue.getById(future.id).status, 'scheduled', 'статус scheduled в БД');

// ── Планировщик забирает то, чей слот наступил ────────────────────────────
const due = draft('scheduled');
db.queue.setSlot(due.id, '2000-01-01 10:00');
assert.equal(db.queue.listDueScheduled(nowStamp()).map((r) => r.id).includes(due.id), true, 'наступивший слот виден планировщику');
assert.equal(db.queue.listDueScheduled(nowStamp()).some((r) => r.id === future.id), false, 'будущий слот не берётся');

posted.length = 0;
const notified = [];
const stop = startPublishScheduler({
  db,
  botsByKey: seat(makeBot()),
  channelId: '@test',
  intervalMs: 20,
  onPublished: async (item, res) => { notified.push(`${item.id}:${res.status}`); },
});
await new Promise((r) => setTimeout(r, 120));
stop();
assert.equal(db.queue.getById(due.id).status, 'published', 'планировщик опубликовал по слоту');
assert.ok(notified.includes(`${due.id}:published`), 'уведомление о публикации отправлено');
assert.equal(db.queue.getById(future.id).status, 'scheduled', 'элемент с будущим слотом не тронут');

db.close();
console.log('✓ smoke-publish PASS — публикуется только одобренное, слот и ошибки канала учтены');
