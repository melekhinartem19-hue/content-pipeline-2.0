// Смоук-тест приёма ролика с ноута клиента (T15, VPS-сторона).
// Оффлайн: настоящий файл во временной папке, фейковый бот Издателя, база в памяти.
// Запуск: node dispatcher/scripts/smoke-video.mjs
//
// Что здесь проверяется: ролик становится публичной ссылкой, встаёт в очередь тем же способом,
// что и любой другой черновик, виден в карточке, доезжает до контейнера Reels — и что «Правка»
// на ролике не зовёт агента, которого на VPS нет.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { platformForKind } from '../src/queue/kinds.js';
import { renderCard, renderQueueList, videoUrl } from '../src/queue/card.js';
import { reworkDraft } from '../src/queue/rework.js';
import { publishToInstagram } from '../src/publish/instagram.js';
import { VIDEO_KIND, checkVideoFile, ingestVideo, publicVideoName, renderIngestReport } from '../src/video/ingest.js';

// ── Стенд ─────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-video-'));
const publicDir = path.join(tmp, 'www');
const inbox = path.join(tmp, 'inbox');
fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(inbox, { recursive: true });

const reel = path.join(inbox, 'Готовый ролик №3.MP4');
fs.writeFileSync(reel, Buffer.alloc(2 * 1024 * 1024, 7)); // 2 МБ «видео»

const config = {
  publicDir,
  publicBaseUrl: 'https://media.example.com',
  videoPublicSubdir: 'video',
  videoMaxBytes: 300 * 1024 * 1024,
  metaGraphVersion: 'v21.0',
  igGraphBaseUrl: 'https://graph.facebook.com',
  igUserId: '17841400000000000',
  igAccessToken: 'token',
  publishDryRun: true,
};

const sent = [];
const publisherBot = {
  api: {
    sendMessage: async (chatId, text, opts) => {
      sent.push({ chatId, text, opts });
      return { message_id: 500 + sent.length };
    },
  },
};
const botsByKey = new Map([['publisher', { identity: { key: 'publisher', topicId: 42 }, bot: publisherBot }]]);

// ── Имя файла в вебе ──────────────────────────────────────────────────────
const name = publicVideoName(reel, new Date(2026, 8, 8, 14, 5, 9));
assert.match(name, /^20260908-140509-/, 'имя начинается с метки времени');
assert.match(name, /\.mp4$/, 'расширение приведено к нижнему регистру');
assert.equal(/^[a-z0-9._-]+$/.test(name), true, `в URL уходит только латиница: ${name}`);
assert.notEqual(publicVideoName(reel, new Date(2026, 8, 8, 14, 5, 10)), name, 'новый ролик не затирает старый');

// ── Проверка файла до копирования ─────────────────────────────────────────
assert.equal(checkVideoFile(path.join(inbox, 'нет.mp4')).ok, false, 'несуществующий файл отсекается');
assert.match(checkVideoFile('').error, /не указан файл/, 'пустой аргумент объясняется');

const wrongExt = path.join(inbox, 'project.aep');
fs.writeFileSync(wrongExt, 'x');
assert.match(checkVideoFile(wrongExt).error, /MP4 или MOV/, 'не-видео отсекается с объяснением');

const empty = path.join(inbox, 'empty.mp4');
fs.writeFileSync(empty, '');
assert.match(checkVideoFile(empty).error, /пустой/, 'недокачанный файл виден сразу');

assert.match(
  checkVideoFile(reel, { maxBytes: 1024 * 1024 }).error,
  /VIDEO_MAX_MB/,
  'слишком тяжёлый ролик отсекается и сказано, чем это лечится',
);
assert.equal(checkVideoFile(reel, { maxBytes: config.videoMaxBytes }).bytes, 2 * 1024 * 1024, 'размер посчитан');

// ── Без публичной статики приём невозможен ────────────────────────────────
const db = openDb(':memory:');
const noStatic = await ingestVideo({ db, file: reel, config: { ...config, publicBaseUrl: null }, botsByKey, groupId: -100 });
assert.equal(noStatic.ok, false, 'без PUBLIC_BASE_URL ролик не принимается');
assert.match(noStatic.error, /video_url/, 'названа причина: IG качает ролик по ссылке');
assert.equal(fs.existsSync(path.join(publicDir, 'video')), false, 'и на диск при этом ничего не легло');
assert.match(renderIngestReport(noStatic), /^✗ ролик не принят/, 'отказ читается человеком');

// ── Боевой путь: ролик → статика → очередь → карточка ─────────────────────
const res = await ingestVideo({
  db,
  file: reel,
  caption: 'Три ошибки на запуске — за 30 секунд',
  title: 'Reels: ошибки на запуске',
  botsByKey,
  groupId: -1001234,
  config,
  now: new Date(2026, 8, 8, 14, 5, 9),
});

assert.equal(res.ok, true, 'ролик принят');
assert.equal(res.url, `https://media.example.com/video/${name}`, 'ссылка собрана из PUBLIC_BASE_URL');
assert.ok(fs.existsSync(path.join(publicDir, 'video', name)), 'файл реально лежит в веб-папке');
assert.equal(fs.statSync(path.join(publicDir, 'video', name)).size, 2 * 1024 * 1024, 'скопирован целиком');
assert.match(renderIngestReport(res), /Одобрить/, 'в отчёте сказано, что публикация — после кнопки');

const item = db.queue.getById(res.id);
assert.equal(item.platform, 'ig', 'ролик идёт по инстаграмной ветке');
assert.equal(platformForKind(VIDEO_KIND), 'ig', 'вид контента известен очереди');
assert.equal(item.status, 'pending', 'ждёт решения владельца — сам никуда не публикуется');
assert.equal(item.agent, 'video', 'автор — видео с ноута');
assert.equal(item.meta.video_url, res.url, 'ссылка на ролик легла в meta');
assert.equal(item.meta.caption, 'Три ошибки на запуске — за 30 секунд', 'подпись там, откуда её берёт IG');
assert.equal(item.meta.source, 'laptop', 'видно, что черновик приехал с ноута, а не от агента');

assert.equal(sent.length, 1, 'карточка отправлена один раз');
assert.equal(sent[0].opts.message_thread_id, 42, 'карточка висит в топике Издателя');
assert.ok(sent[0].opts.reply_markup.inline_keyboard.length, 'у карточки есть кнопки решения');
assert.equal(item.card_message_id, 501, 'связь карточки с элементом сохранена в БД');

assert.equal(videoUrl(item), res.url, 'ссылка на ролик распознаётся');
assert.equal(videoUrl({ meta: { video_url: '/local/path.mp4' } }), null, 'локальный путь ссылкой не считается');
assert.match(renderCard(item), /🎬 Ролик: https:\/\/media\.example\.com\/video\//, 'владелец видит ссылку до «Одобрить»');
assert.match(renderQueueList([item], {}), /🎬/, 'в списке очереди ролик отличим от текста');

// ── Подпись необязательна, слот календаря работает ────────────────────────
const silent = await ingestVideo({
  db,
  file: reel,
  botsByKey,
  groupId: -1001234,
  config,
  slotAt: '2026-09-10 10:00',
  now: new Date(2026, 8, 8, 15, 0, 0),
});
const silentItem = db.queue.getById(silent.id);
assert.match(silentItem.content, /без подписи/, 'пустая подпись видна в карточке, а не молчит');
assert.equal(silentItem.meta.caption, '', 'в IG уйдёт пустая подпись — это законно');
assert.equal(silentItem.slot_at, '2026-09-10 10:00', 'слот календаря записан');

// ── Правка ролика: агента на VPS нет, вызов claude не тратим ───────────────
let runnerCalls = 0;
const rework = await reworkDraft({
  db,
  item,
  note: 'убери первые 2 секунды',
  publisherBot,
  groupId: -1001234,
  topicId: 42,
  runner: async () => {
    runnerCalls += 1;
    return { ok: true, content: 'не должно случиться' };
  },
});
assert.equal(rework.ok, false, 'ролик на VPS не переделывается');
assert.equal(runnerCalls, 0, 'claude -p не зовётся впустую');
assert.match(rework.error, /ingest:video/, 'сказано, что делать: перемонтировать и залить заново');

// ── Дальше по трубе: принятый ролик доезжает до контейнера Reels ───────────
const plan = await publishToInstagram({ item: db.queue.getById(res.id), config, sleep: async () => {} });
assert.equal(plan.dryRun, true, 'сухой прогон: наружу ничего не ушло');
const container = plan.plan.find((s) => s.params?.media_type === 'REELS');
assert.ok(container, 'создаётся контейнер именно Reels');
assert.equal(container.params.video_url, res.url, 'публикуется тот самый ролик');
assert.equal(container.params.caption, 'Три ошибки на запуске — за 30 секунд', 'с той самой подписью');

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('✅ smoke-video: приём ролика, карточка, слот, правка и путь в Reels — ок');
