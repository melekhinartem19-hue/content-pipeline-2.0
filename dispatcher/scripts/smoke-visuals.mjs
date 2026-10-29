// Смоук-тест связки «рендер → топики → очередь» (T10).
// Оффлайн: вместо Telegram — фейковые боты, вместо браузера — подставной рендерер.
// Запуск: node dispatcher/scripts/smoke-visuals.mjs
//
// Сам рендер в PNG проверяет smoke-render.mjs. Здесь проверяется ДИСПЕТЧЕРСКАЯ часть: кто, куда
// и в каком порядке шлёт картинки, что попадает в meta элемента очереди и что происходит,
// когда рендер не удался.
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import {
  ALBUM_LIMIT,
  attachVisuals,
  isRenderable,
  parseRenderCommand,
  postPhotos,
  renderFolderName,
  rerenderQueueItem,
} from '../src/render/visuals.js';
import { enqueueAgentResult } from '../src/queue/approval.js';
import { imageCount, renderCard, renderQueueList } from '../src/queue/card.js';

// ── Что вообще рендерится ─────────────────────────────────────────────────
assert.equal(isRenderable({ kind: 'carousel_spec' }), true, 'карусель рендерится');
assert.equal(isRenderable({ kind: 'cover_spec' }), true, 'обложка рендерится');
assert.equal(isRenderable({ kind: 'tg_post' }), false, 'у поста визуала нет');
assert.equal(isRenderable(null), false, 'пустой META не роняет проверку');

assert.match(renderFolderName('carousel_spec', new Date(2026, 8, 7, 14, 30, 5)), /^20260907-143005-carousel_spec$/);
assert.equal(parseRenderCommand('/рендер 12'), 12, 'команда рендера по id');
assert.equal(parseRenderCommand('рендер #7'), 7, 'решётка и без слэша тоже');
assert.equal(parseRenderCommand('/render 3'), 3, 'латинский вариант');
assert.equal(parseRenderCommand('рендерить карусель'), null, 'похожий текст командой не считается');

// ── Стенд: боты Дизайнера и Издателя ──────────────────────────────────────
function makeBot(key, log) {
  return {
    api: {
      sendPhoto: async (chatId, media, opts) => {
        log.push({ key, method: 'sendPhoto', chatId, media, opts });
        return { message_id: log.length, photo: [{ file_id: `f${log.length}s` }, { file_id: `f${log.length}` }] };
      },
      sendMediaGroup: async (chatId, media, opts) => {
        log.push({ key, method: 'sendMediaGroup', chatId, media, opts });
        return media.map((_, i) => ({ message_id: 100 + i, photo: [{ file_id: `g${log.length}-${i}` }] }));
      },
      sendMessage: async (chatId, text, opts) => {
        log.push({ key, method: 'sendMessage', chatId, text, opts });
        return { message_id: 900 + log.length };
      },
    },
  };
}

function stand() {
  const log = [];
  const botsByKey = new Map([
    ['designer', { identity: { key: 'designer', agent: 'designer', topicId: 43 }, bot: makeBot('designer', log) }],
    ['publisher', { identity: { key: 'publisher', agent: 'publisher', topicId: 19 }, bot: makeBot('publisher', log) }],
  ]);
  return { log, botsByKey };
}

/** Подставной рендерер: файлов сколько попросили, браузер не нужен. */
const fakeRenderer =
  (files, extra = {}) =>
  async () => ({ ok: true, files, dir: 'C:/renders/x', note: 'карусель, слайдов: ' + files.length, ...extra });

const META = { kind: 'carousel_spec', status: 'draft', title: 'Пять причин' };
const SPEC = '=== СЛАЙД 1 ===\nЗаголовок: А\n\n=== СЛАЙД 2 ===\nЗаголовок: Б';

// ── Не рендерится → шаг холостой, рендерер даже не зовётся ────────────────
{
  const { log, botsByKey } = stand();
  let called = false;
  const res = await attachVisuals({
    agent: 'writer',
    meta: { kind: 'tg_post' },
    content: 'текст',
    botsByKey,
    groupId: -100123,
    renderer: async () => ((called = true), { ok: true, files: [] }),
  });
  assert.equal(called, false, 'для поста рендерер не вызывается');
  assert.equal(log.length, 0, 'в Telegram ничего не ушло');
  assert.deepEqual(res.meta, { kind: 'tg_post' }, 'META не тронут');
}

// ── Карусель: альбом Дизайнеру, тот же альбом Издателю по file_id ─────────
{
  const { log, botsByKey } = stand();
  const files = ['C:/renders/x/slide-01.png', 'C:/renders/x/slide-02.png', 'C:/renders/x/slide-03.png'];
  const res = await attachVisuals({
    agent: 'designer',
    meta: META,
    content: SPEC,
    botsByKey,
    groupId: -100123,
    renderer: fakeRenderer(files),
  });

  assert.equal(log.length, 2, 'ровно две отправки: автору и Издателю');
  assert.equal(log[0].key, 'designer', 'первым картинки получает топик Дизайнера');
  assert.equal(log[0].opts.message_thread_id, 43, 'в топик Дизайнера');
  assert.equal(log[0].method, 'sendMediaGroup', 'три кадра уходят альбомом');
  assert.equal(log[0].media.length, 3, 'все три кадра в альбоме');
  assert.match(log[0].media[0].caption, /Визуал готов/, 'подпись у первого кадра');
  assert.ok(!log[0].media[1].caption, 'у остальных кадров подписи нет');

  assert.equal(log[1].key, 'publisher', 'вторым — топик Издателя');
  assert.equal(log[1].opts.message_thread_id, 19, 'в топик Издателя');
  // Гоча, найденная живым прогоном: file_id привязан к боту, чужим ботом он невалиден
  // («Wrong file identifier/HTTP URL specified»). Издатель обязан загружать файлы заново.
  assert.ok(
    log[1].media.every((m) => typeof m.media === 'object'),
    'Издатель загружает файлы заново (InputFile), а не шлёт чужой file_id',
  );
  assert.equal(log[1].media.length, 3, 'у Издателя тот же набор кадров');

  assert.deepEqual(res.meta.images, files, 'пути к картинкам записаны в META');
  assert.equal(res.meta.photo, files[0], 'photo = первый кадр — его подхватит публикация T08');
  assert.equal(res.meta.kind, 'carousel_spec', 'исходные поля META сохранены');
  assert.equal(res.error, null, 'ошибок нет');
  assert.equal(res.meta.tg_file_ids.length, 3, 'file_id запомнены для повторной отправки');
  assert.equal(res.meta.tg_file_ids_bot, 'designer', 'помечено, чьему боту принадлежат file_id');
}

// ── Обложка: один кадр альбомом Telegram не примет — шлём фото ────────────
{
  const { log, botsByKey } = stand();
  await attachVisuals({
    agent: 'designer',
    meta: { kind: 'cover_spec' },
    content: '=== ОБЛОЖКА ===\nЗаголовок: А',
    botsByKey,
    groupId: -100123,
    renderer: fakeRenderer(['C:/renders/x/cover.png']),
  });
  assert.equal(log[0].method, 'sendPhoto', 'одиночный кадр уходит sendPhoto, а не media-group');
}

// ── Больше лимита альбома: режется на группы ──────────────────────────────
{
  const { log, botsByKey } = stand();
  const many = Array.from({ length: ALBUM_LIMIT + 2 }, (_, i) => `C:/renders/x/slide-${i}.png`);
  await attachVisuals({
    agent: 'designer',
    meta: META,
    content: SPEC,
    botsByKey,
    groupId: -100123,
    renderer: fakeRenderer(many),
  });
  const toDesigner = log.filter((e) => e.key === 'designer');
  assert.equal(toDesigner.length, 2, 'кадры сверх лимита ушли второй группой');
  assert.equal(toDesigner[0].media.length, ALBUM_LIMIT, `в первой группе ${ALBUM_LIMIT} кадров`);
  assert.equal(toDesigner[1].media.length, 2, 'во второй — остаток');
}

// ── Рендер упал: черновик не теряется, причина возвращается ───────────────
{
  const { log, botsByKey } = stand();
  const res = await attachVisuals({
    agent: 'designer',
    meta: META,
    content: SPEC,
    botsByKey,
    groupId: -100123,
    renderer: async () => {
      throw new Error('не найден headless-браузер');
    },
  });
  assert.equal(log.length, 0, 'при падении рендера в топики ничего не шлём');
  assert.match(res.error, /не найден headless-браузер/, 'причина сохранена');
  assert.deepEqual(res.meta, META, 'META осталась исходной — картинок-то нет');
}

// ── У агента не задан топик: файлы есть, но человеку надо сказать куда ────
{
  const { log } = stand();
  const botsByKey = new Map([
    ['designer', { identity: { key: 'designer', agent: 'designer', topicId: null }, bot: makeBot('designer', log) }],
  ]);
  const res = await attachVisuals({
    agent: 'designer',
    meta: META,
    content: SPEC,
    botsByKey,
    groupId: -100123,
    renderer: fakeRenderer(['C:/renders/x/slide-01.png', 'C:/renders/x/slide-02.png']),
  });
  assert.equal(log.length, 0, 'без топика отправлять некуда');
  assert.match(res.error, /не задан топик/, 'сказано, почему картинок нет в чате');
  assert.match(res.error, /C:.renders.x/, 'подсказан путь, где лежат файлы');
  assert.equal(res.meta.images.length, 2, 'в META пути всё равно записаны');
}

// ── Очередь: картинки едут вместе с черновиком ────────────────────────────
{
  const db = openDb(':memory:');
  const { log, botsByKey } = stand();
  const files = ['C:/renders/x/slide-01.png', 'C:/renders/x/slide-02.png'];

  const res = await enqueueAgentResult({
    db,
    agent: 'designer',
    meta: META,
    content: SPEC,
    botsByKey,
    groupId: -100123,
    visualizer: (o) => attachVisuals({ ...o, renderer: fakeRenderer(files) }),
  });

  assert.equal(res.enqueued, true, 'карусель встала в очередь');
  assert.deepEqual(res.images, files, 'вызывающему вернули список картинок');

  const item = db.queue.getById(res.id);
  assert.deepEqual(item.meta.images, files, 'пути к картинкам сохранились в БД');
  assert.equal(imageCount(item), 2, 'карточка знает, сколько кадров');
  assert.match(renderCard(item), /🖼 Картинок: 2/, 'в карточке видно, что визуал есть');
  assert.match(renderQueueList([item]), /🖼2/, 'в списке очереди тоже');

  // Порядок важен: альбом должен встать НАД карточкой, иначе согласуют вслепую.
  const publisherEvents = log.filter((e) => e.key === 'publisher');
  assert.equal(publisherEvents[0].method, 'sendMediaGroup', 'сначала картинки');
  assert.equal(publisherEvents[1].method, 'sendMessage', 'потом карточка с кнопками');
  assert.ok(publisherEvents[1].opts.reply_markup, 'у карточки есть кнопки');

  // ── Повторный рендер по «/рендер N»: агента не зовём, META обновляется ──
  const again = ['C:/renders/y/slide-01.png', 'C:/renders/y/slide-02.png', 'C:/renders/y/slide-03.png'];
  const re = await rerenderQueueItem({
    db,
    id: res.id,
    botsByKey,
    groupId: -100123,
    renderer: fakeRenderer(again),
  });
  assert.equal(re.ok, true, 'повторный рендер прошёл');
  assert.deepEqual(db.queue.getById(res.id).meta.images, again, 'META перезаписана новыми кадрами');
  assert.equal(db.queue.getById(res.id).content, SPEC, 'спецификация не менялась — агента не звали');
  assert.equal(db.queue.getById(res.id).status, 'pending', 'элемент остался на согласовании');

  const missing = await rerenderQueueItem({ db, id: 999, botsByKey, groupId: -100123 });
  assert.equal(missing.ok, false, 'несуществующий элемент — не рендерим');
  assert.match(missing.error, /не найден/, 'причина понятна');

  const postId = db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'текст' });
  const notVisual = await rerenderQueueItem({ db, id: postId, botsByKey, groupId: -100123 });
  assert.equal(notVisual.ok, false, 'у поста рендерить нечего');
  assert.match(notVisual.error, /нет визуала/, 'сказано прямо');

  db.close();
}

// ── postPhotos: подпись только у первой группы ────────────────────────────
{
  const log = [];
  const bot = makeBot('x', log);
  const ids = await postPhotos(bot, -1, 5, ['a.png', 'b.png'], 'подпись');
  assert.equal(ids.length, 2, 'file_id вернулись для всех кадров');
  assert.equal(log[0].media[0].caption, 'подпись', 'подпись у первого кадра');
}

console.log('✅ smoke-visuals: рендер, альбомы по топикам и META очереди — ок');
