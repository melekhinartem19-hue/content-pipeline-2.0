// Смоук-тест публикации в Threads (T11) и Instagram (T12).
//
// ОФФЛАЙН: fetch подменён, в Meta не уходит ни одного запроса, ничего не публикуется.
// Проверяется механика: шаги Graph API, публичные ссылки на картинки, лимиты, разбор ошибок Meta,
// сухой прогон и то, что 18-значный id поста доживает до БД без потери цифр.
// Запуск: node dispatcher/scripts/smoke-ig-threads.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { publishItem } from '../src/publish/index.js';
import { GraphError, createGraphClient, describePlan, toGraphError } from '../src/publish/graph.js';
import { imageUrlsFor, localImages, mediaReady, publishFiles } from '../src/publish/media.js';
import { THREADS_TEXT_LIMIT, publishToThreads, threadsReady } from '../src/publish/threads.js';
import { IG_CAROUSEL_MAX, igReady, pickCaption, publishToInstagram } from '../src/publish/instagram.js';

// ── Стенд: временная «Nginx-статика» и нарисованные кадры ─────────────────
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-public-'));
const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-renders-'));
const frames = ['slide-1.png', 'slide-2.png', 'slide-3.png'].map((name) => {
  const file = path.join(rendersDir, name);
  fs.writeFileSync(file, 'PNG');
  return file;
});

const config = {
  metaGraphVersion: 'v21.0',
  igGraphBaseUrl: 'https://graph.facebook.com',
  igUserId: '17841400000000000',
  igAccessToken: 'ig-token',
  threadsGraphBaseUrl: 'https://graph.threads.net',
  threadsUserId: '98765',
  threadsAccessToken: 'th-token',
  publicDir,
  publicBaseUrl: 'https://media.example.com/',
  publishDryRun: false,
  igPollMs: 1,
  igStatusAttempts: 3,
};

// ── Фейковый Graph API ────────────────────────────────────────────────────
const IG_POST_ID = '17895695668004550'; // 17 цифр — в JS-число такое класть уже нельзя
const TH_POST_ID = '27895695668004551';
let calls = [];
let containerNo = 0;
let videoStatuses = ['FINISHED'];

const graphFetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts?.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
  calls.push({ url: u, method: opts.method || 'GET', body });
  const json = (data) => ({ ok: true, status: 200, json: async () => data });

  if (u.includes('/media_publish')) return json({ id: IG_POST_ID });
  if (u.includes('/threads_publish')) return json({ id: TH_POST_ID });
  if (u.includes('/threads')) return json({ id: `th-container-${++containerNo}` });
  if (u.includes('/media')) return json({ id: `ig-container-${++containerNo}` });
  if (u.includes('fields=status_code')) return json({ status_code: videoStatuses.shift() || 'FINISHED' });
  return json({ status_code: videoStatuses.shift() || 'FINISHED' });
};

const reset = () => {
  calls = [];
  containerNo = 0;
};

// ── Graph-клиент: токен не светится в URL, ошибки Meta переводятся ─────────
reset();
const client = createGraphClient({ baseUrl: 'https://graph.threads.net', version: 'v21.0', token: 'secret', fetchImpl: graphFetch });
await client.post('123/threads', { media_type: 'TEXT', text: 'привет' });
assert.ok(!calls[0].url.includes('secret'), 'токен не уходит в URL (он оседает в логах прокси)');
assert.equal(calls[0].body.access_token, 'secret', 'токен уходит в теле формы');

const err190 = toGraphError(400, { error: { message: 'Error validating access token', code: 190, fbtrace_id: 'abc' } });
assert.ok(err190 instanceof GraphError, 'ошибка Meta — типизированная');
assert.match(err190.message, /токен доступа недействителен/, 'код 190 объяснён словами');
assert.equal(err190.trace, 'abc', 'fbtrace_id сохранён для поддержки Meta');
assert.match(toGraphError(400, { error: { message: 'x', code: 9004 } }).message, /публичной и по HTTPS/, '9004 объясняет ссылку');
assert.match(toGraphError(403, { error: { message: 'x', code: 10 } }).message, /admin|админ/i, 'нехватка прав объяснена dev-mode');

// Сухой прогон: запросы не уходят, но план виден.
reset();
const dry = createGraphClient({ baseUrl: 'https://graph.threads.net', version: 'v21.0', token: 't', dryRun: true, fetchImpl: graphFetch });
const dryRes = await dry.post('123/threads', { text: 'a' });
assert.equal(calls.length, 0, 'в сухом прогоне сеть не трогается');
assert.match(dryRes.id, /^dry-/, 'сухой прогон возвращает фиктивный id');
assert.match(describePlan(dry.plan), /graph\.threads\.net/, 'план читаем человеком');

// ── Threads (T11): только текст, два шага ─────────────────────────────────
assert.equal(threadsReady({}).ok, false, 'без кредов Threads не готов');
assert.match(threadsReady({}).error, /THREADS_USER_ID/, 'сказано, чего не хватает');
assert.equal(threadsReady(config).ok, true, 'с кредами готов');

reset();
const th = await publishToThreads({ item: { content: 'Короткий пост в Threads' }, config, fetchImpl: graphFetch });
assert.equal(th.ref, TH_POST_ID, 'вернулся id поста');
assert.equal(calls.length, 2, 'два шага: контейнер и публикация');
assert.match(calls[0].url, /graph\.threads\.net\/v21\.0\/98765\/threads$/, 'контейнер создаётся у своего аккаунта');
assert.equal(calls[0].body.media_type, 'TEXT', 'Threads публикуем только текстом');
assert.match(calls[1].url, /threads_publish$/, 'второй шаг — публикация');
assert.equal(calls[1].body.creation_id, 'th-container-1', 'публикуется созданный контейнер');

await assert.rejects(
  () => publishToThreads({ item: { content: 'я'.repeat(THREADS_TEXT_LIMIT + 1) }, config, fetchImpl: graphFetch }),
  /не больше 500/,
  'длинный текст не режется молча, а честно отклоняется',
);
await assert.rejects(() => publishToThreads({ item: { content: '   ' }, config, fetchImpl: graphFetch }), /пустой текст/);

// Ошибка Meta доходит наверх причиной, а не «что-то пошло не так».
await assert.rejects(
  () =>
    publishToThreads({
      item: { content: 'текст' },
      config,
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth', code: 190 } }) }),
    }),
  /токен доступа недействителен/,
  'протухший токен объясняется словами',
);

// ── Картинки → публичные ссылки (без них IG невозможен) ───────────────────
assert.equal(mediaReady({}).ok, false, 'без статики публиковать в IG нельзя');
assert.match(mediaReady({}).error, /PUBLIC_BASE_URL/, 'названо, что задать');

const copied = publishFiles({ files: frames, config, subdir: 'queue-7' });
assert.equal(copied.urls.length, 3, 'ссылки на все кадры');
assert.equal(copied.urls[0], 'https://media.example.com/queue-7/slide-1.png', 'URL собран из PUBLIC_BASE_URL');
assert.ok(fs.existsSync(path.join(publicDir, 'queue-7', 'slide-1.png')), 'кадр реально лежит в веб-папке');

assert.deepEqual(localImages({ images: frames }), frames, 'локальные кадры распознаны');
assert.deepEqual(localImages({ images: ['https://x/y.png'] }), [], 'готовые ссылки копировать не надо');
assert.equal(
  imageUrlsFor({ item: { id: 1, meta: { image_urls: ['https://cdn/a.png'] } }, config }).source,
  'meta',
  'если ссылки уже есть — берём их',
);

// ── Instagram (T12): карусель, обложка, лимиты ────────────────────────────
assert.equal(igReady({}).ok, false, 'без кредов IG не готов');
assert.match(igReady({}).error, /IG_ACCESS_TOKEN/, 'сказано, чего не хватает');
assert.equal(pickCaption({ meta: { caption: ' Подпись ' } }), 'Подпись', 'подпись берётся из META агента');
assert.equal(pickCaption({ meta: {}, content: 'спецификация слайдов' }), '', 'спецификация Дизайнера подписью НЕ становится');

reset();
const carousel = await publishToInstagram({
  item: { id: 7, kind: 'carousel_spec', content: '=== СЛАЙД 1 ===', meta: { images: frames, caption: 'Три ошибки на запуске' } },
  config,
  fetchImpl: graphFetch,
});
assert.equal(carousel.ref, IG_POST_ID, 'вернулся id поста');
assert.equal(calls.length, 5, '3 кадра + контейнер карусели + публикация');
assert.equal(calls[0].body.is_carousel_item, 'true', 'кадры создаются элементами карусели');
assert.match(calls[0].body.image_url, /^https:\/\/media\.example\.com\//, 'в Meta уходит ПУБЛИЧНАЯ ссылка, а не путь');
assert.equal(calls[3].body.media_type, 'CAROUSEL', 'затем контейнер-карусель');
assert.equal(calls[3].body.children.split(',').length, 3, 'в карусели все три кадра');
assert.equal(calls[3].body.caption, 'Три ошибки на запуске', 'подпись ушла с постом');
assert.match(calls[4].url, /media_publish$/, 'последний шаг — публикация');

// Одиночная обложка — обычный пост, без шага карусели.
reset();
const cover = await publishToInstagram({
  item: { id: 8, kind: 'cover_spec', content: 'x', meta: { images: [frames[0]] } },
  config,
  fetchImpl: graphFetch,
});
assert.equal(calls.length, 2, 'один кадр = контейнер + публикация');
assert.ok(!calls[0].body.media_type, 'CAROUSEL для одного кадра не создаётся');
assert.match(cover.note, /подписи нет/, 'отсутствие подписи не скрывается, а проговаривается');

// Лимиты и пустые случаи.
await assert.rejects(
  () =>
    publishToInstagram({
      item: { id: 9, kind: 'carousel_spec', meta: { image_urls: Array.from({ length: IG_CAROUSEL_MAX + 1 }, (_, i) => `https://cdn/${i}.png`) } },
      config,
      fetchImpl: graphFetch,
    }),
  /не больше 10/,
  'карусель длиннее 10 кадров отклоняется до вызова Meta',
);

const noImages = await publishToInstagram({ item: { id: 10, kind: 'carousel_spec', meta: {} }, config, fetchImpl: graphFetch });
assert.equal(noImages.skip, true, 'без картинок публиковать нечего');
assert.match(noImages.reason, /рендер/, 'подсказано, что сделать (T10)');

const script = await publishToInstagram({ item: { id: 11, kind: 'reels_script', meta: {} }, config, fetchImpl: graphFetch });
assert.equal(script.skip, true, 'сценарий Reels — не ролик');
assert.match(script.reason, /T15/, 'сказано, где ролик появится');

// Reels с готовым роликом: контейнер → ожидание обработки → публикация.
reset();
videoStatuses = ['IN_PROGRESS', 'FINISHED'];
const reels = await publishToInstagram({
  item: { id: 12, kind: 'reels_script', meta: { video_url: 'https://media.example.com/reel.mp4', caption: 'Рилс' } },
  config,
  fetchImpl: graphFetch,
  sleep: async () => {},
});
assert.equal(reels.ref, IG_POST_ID, 'Reels опубликован');
assert.equal(calls[0].body.media_type, 'REELS', 'контейнер видео');
assert.ok(calls.some((c) => c.url.includes('status_code')), 'статус обработки опрашивается');

videoStatuses = ['ERROR'];
await assert.rejects(
  () =>
    publishToInstagram({
      item: { id: 13, kind: 'reels_script', meta: { video_url: 'https://x/v.mp4' } },
      config,
      fetchImpl: graphFetch,
      sleep: async () => {},
    }),
  /не смог обработать видео/,
  'сбой обработки видео виден причиной',
);
videoStatuses = ['FINISHED'];

// ── Очередь: только одобренное, статусы, 18-значный id ────────────────────
const db = openDb(':memory:');
assert.ok(db.appliedMigrations.includes('006_publish_refs'), 'миграция 006_publish_refs должна примениться');

const add = (platform, kind, status, meta = null) =>
  db.queue.getById(db.queue.add({ platform, agent: 'writer', kind, content: 'Пост для площадки', status, meta }));

const draftTh = add('threads', 'threads_post', 'pending');
const notApproved = await publishItem({ db, item: draftTh, config, fetchImpl: graphFetch });
assert.equal(notApproved.status, 'skipped', 'неодобренное в Threads не уходит');

reset();
const okTh = add('threads', 'threads_post', 'approved');
const resTh = await publishItem({ db, item: okTh, config, fetchImpl: graphFetch });
assert.equal(resTh.status, 'published', 'одобренный текст опубликован в Threads');
const storedTh = db.queue.getById(okTh.id);
assert.equal(storedTh.status, 'published', 'статус в БД');
assert.equal(storedTh.published_ref, TH_POST_ID, '18-значный id поста дожил до БД без потери цифр');

reset();
const okIg = add('ig', 'carousel_spec', 'approved', { images: frames, caption: 'Подпись' });
const resIg = await publishItem({ db, item: okIg, config, fetchImpl: graphFetch });
assert.equal(resIg.status, 'published', 'карусель опубликована');
assert.equal(db.queue.getById(okIg.id).published_ref, IG_POST_ID, 'id поста IG сохранён строкой');

// Сухой прогон: ничего не отправлено и статус НЕ изменился — иначе БД врала бы.
reset();
const dryItem = add('threads', 'threads_post', 'approved');
const dryRes2 = await publishItem({ db, item: dryItem, config: { ...config, publishDryRun: true }, fetchImpl: graphFetch });
assert.equal(dryRes2.status, 'skipped', 'сухой прогон не публикует');
assert.match(dryRes2.reason, /PUBLISH_DRY_RUN/, 'причина названа');
assert.match(dryRes2.reason, /threads_publish/, 'показан план вызовов');
assert.equal(calls.length, 0, 'в сеть ничего не ушло');
assert.equal(db.queue.getById(dryItem.id).status, 'approved', 'статус остался прежним');

// Нет кредов → publish_failed с причиной, повтор возможен после правки .env.
const noCreds = add('ig', 'carousel_spec', 'approved', { images: frames });
const failRes = await publishItem({ db, item: noCreds, config: { ...config, igUserId: null, igAccessToken: null }, fetchImpl: graphFetch });
assert.equal(failRes.status, 'failed', 'без кредов — честная ошибка');
assert.match(db.queue.getById(noCreds.id).publish_error, /IG_USER_ID/, 'причина сохранена в БД');
const retry = await publishItem({ db, item: db.queue.getById(noCreds.id), config, fetchImpl: graphFetch });
assert.equal(retry.status, 'published', 'после починки настроек публикация повторяется');

// Слот контент-календаря работает одинаково для всех площадок.
const slotted = add('threads', 'threads_post', 'approved');
db.queue.setSlot(slotted.id, '2099-01-01 10:00');
const scheduled = await publishItem({ db, item: db.queue.getById(slotted.id), config, fetchImpl: graphFetch });
assert.equal(scheduled.status, 'scheduled', 'будущий слот откладывает и Threads');

db.close();
fs.rmSync(publicDir, { recursive: true, force: true });
fs.rmSync(rendersDir, { recursive: true, force: true });
console.log('✓ smoke-ig-threads PASS — шаги Graph API, публичные ссылки, лимиты и сухой прогон на месте');
