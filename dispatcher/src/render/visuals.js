// Мост «ответ Дизайнера → картинки в топике» (T10).
//
// Здесь диспетчер соединяет два своих мира: модуль `render/` (чистый рендер, ничего не знает про
// Telegram) и очередь согласования (T07, ничего не знает про картинки). Всё телеграмное и все
// решения «куда постить» живут в этом файле — так render/ остаётся переносимым, а очередь чистой.
//
// ПОЧЕМУ РЕНДЕР ИДЁТ ДО КАРТОЧКИ. Владелец должен согласовывать ВИЗУАЛ, а не описание визуала:
// по тексту «Визуал: крупная цифра, акцент в центре» решение не примешь. Поэтому порядок такой:
//
//   ответ Дизайнера → PNG → альбом в топик Дизайнера → тот же альбом в топик Издателя → карточка
//
// Во второй раз файлы НЕ загружаются повторно: Telegram вернул file_id при первой отправке, и
// пересылка по нему бесплатна и мгновенна.
//
// ПРАВИЛО «РЕНДЕР НЕ РОНЯЕТ КОНВЕЙЕР». Нет браузера, агент съехал с формата, Telegram отверг
// картинку — черновик всё равно встаёт в очередь, а причина уходит текстом в топик. Потерять
// готовый текст из-за неудавшейся картинки было бы худшим разменом.

import path from 'node:path';
import { InputFile } from 'grammy';
import { renderDesign } from '../../../render/index.js';
import { config } from '../config.js';

/** Виды контента, у которых есть визуал. Остальное проходит мимо рендера. */
export const RENDERABLE_KINDS = new Set(['carousel_spec', 'cover_spec']);

/** Максимум картинок в одном media-group Telegram. Совпадает с лимитом карусели Instagram. */
export const ALBUM_LIMIT = 10;

/** Лимит подписи к альбому (подпись у первой картинки). */
const CAPTION_LIMIT = 1024;

/** Есть ли у этого ответа агента что рендерить. */
export function isRenderable(meta) {
  return RENDERABLE_KINDS.has(String(meta?.kind || ''));
}

/**
 * Имя папки прогона: время + вид. Читается человеком и не конфликтует между прогонами.
 * @returns {string} например `20260907-143005-carousel_spec`
 */
export function renderFolderName(kind, at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${stamp}-${String(kind || 'design').replace(/[^\w-]/g, '')}`;
}

/**
 * Рендерит визуал ответа агента и раскладывает его по топикам.
 *
 * Вызывается из очереди согласования (queue/approval.js) ДО создания карточки. Для видов без
 * визуала возвращает исходный meta и ничего не делает — вызывающему не нужно об этом думать.
 *
 * @param {object} o
 * @param {string} o.agent  ключ агента-автора (обычно 'designer')
 * @param {object} o.meta  META-конверт ответа агента
 * @param {string} o.content  текст ответа (спецификация со слайдами)
 * @param {Map<string,{bot:object, identity:object}>} o.botsByKey  поднятые боты
 * @param {number|string|null} o.groupId  форум-группа
 * @param {string} [o.publisherKey]
 * @param {string} [o.outRoot]  корень для папок рендера (по умолчанию config.rendersDir)
 * @param {Function} [o.renderer]  инъекция для тестов (default: renderDesign)
 * @returns {Promise<{meta:object, files:string[], dir:string|null, note:string|null, error:string|null}>}
 */
export async function attachVisuals({
  agent,
  meta,
  content,
  botsByKey,
  groupId,
  publisherKey = 'publisher',
  outRoot = null,
  renderer = renderDesign,
}) {
  const idle = { meta, files: [], dir: null, note: null, error: null };
  if (!isRenderable(meta)) return idle;

  const root = outRoot || config.rendersDir;
  const dir = path.join(root, renderFolderName(meta.kind));

  let res;
  try {
    res = await renderer({
      content,
      kind: meta.kind,
      outDir: dir,
      brandBrainDir: config.brandBrainDir,
    });
  } catch (err) {
    // Браузер не стартовал, нет прав на папку и т.п. — конвейер продолжается без картинок.
    return { ...idle, error: err.message };
  }

  if (!res.ok) return { ...idle, error: res.error };

  const author = botsByKey?.get(agent);
  const publisher = botsByKey?.get(publisherKey);
  const caption = `🖼 Визуал готов · ${res.note}`;

  // 1) Картинки — в топик автора. Это и есть требование T10: готовые изображения у Дизайнера.
  let fileIds = [];
  let sendError = null;
  if (author?.bot && groupId && author.identity?.topicId != null) {
    try {
      fileIds = await postPhotos(author.bot, groupId, author.identity.topicId, res.files, caption);
    } catch (err) {
      sendError = `картинки отрендерены (${res.files.length}), но не отправились в топик: ${err.message}`;
    }
  } else {
    sendError = `картинки отрендерены (${res.files.length}), но у агента «${agent}» не задан топик — файлы в ${res.dir}`;
  }

  // 2) Те же картинки — над карточкой у Издателя, чтобы согласовывали визуал, а не описание.
  //
  // ⚠ ГОЧА, НАЙДЕННАЯ ЖИВЫМ ПРОГОНОМ: file_id в Telegram ПРИВЯЗАН К БОТУ. Идентификатор,
  // полученный ботом Дизайнера при загрузке, для бота Издателя невалиден — Telegram отвечает
  // «Wrong file identifier/HTTP URL specified». Поэтому Издатель загружает файлы заново,
  // а не пересылает по id. Вторая загрузка дёшева (кадр ~200 КБ) и это единственный
  // корректный путь, пока картинки шлёт другой бот.
  if (publisher?.bot && groupId && publisher.identity?.topicId != null) {
    await postPhotos(publisher.bot, groupId, publisher.identity.topicId, res.files, caption).catch((err) =>
      console.error('[render] альбом в топик Издателя:', err.message),
    );
  }

  return {
    // Пути к файлам едут в meta элемента очереди: оттуда их возьмут публикация в TG (photo —
    // его уже читает pickPhoto из T08), IG-карусель (T12) и сборка PDF (T13).
    meta: {
      ...meta,
      images: res.files,
      photo: res.files[0],
      render_dir: res.dir,
      render_note: res.note,
      // file_id принадлежат боту АВТОРА (см. гочу выше) — другим ботом их использовать нельзя.
      // Годятся для повторной отправки тем же ботом в тот же чат.
      tg_file_ids: fileIds,
      tg_file_ids_bot: agent,
    },
    files: res.files,
    dir: res.dir,
    note: res.note,
    error: sendError,
  };
}

/**
 * Разбирает «/рендер 12» («/render 12») → 12. Не команда → null.
 * Зачем отдельная команда: рендер может не удаться по внешней причине (браузер не поднялся,
 * Telegram отверг файл), и повторять ради этого весь путь «цель → Продюсер → Дизайнер»
 * дорого — там каждый шаг это вызов claude -p.
 */
export function parseRenderCommand(text) {
  const m = /^\/?(рендер|render)\s+#?(\d+)\s*$/iu.exec(String(text || '').trim());
  return m ? Number(m[2]) : null;
}

/**
 * Перерисовывает визуал уже стоящего в очереди элемента и обновляет его meta.
 * Спецификация берётся из БД — агент повторно НЕ вызывается (claude -p не тратится).
 * @returns {Promise<{ok:boolean, id:number, files?:string[], note?:string, error?:string}>}
 */
export async function rerenderQueueItem({
  db,
  id,
  botsByKey,
  groupId,
  publisherKey = 'publisher',
  renderer = renderDesign,
}) {
  const item = db.queue.getById(id);
  if (!item) return { ok: false, id, error: `черновик #${id} не найден` };
  if (!isRenderable({ kind: item.kind })) {
    return { ok: false, id, error: `у #${id} нет визуала: ${item.kind} не рендерится` };
  }

  const res = await attachVisuals({
    agent: item.agent,
    meta: item.meta || { kind: item.kind },
    content: item.content,
    botsByKey,
    groupId,
    publisherKey,
    renderer,
  });
  if (!res.files.length) return { ok: false, id, error: res.error || 'рендер не дал ни одного кадра' };

  db.queue.setMeta(id, res.meta);
  return { ok: true, id, files: res.files, note: res.note, error: res.error };
}

/**
 * Отправляет картинки в топик. Одна — обычным фото, несколько — альбомом.
 * Telegram принимает media-group строго от 2 до 10 элементов, поэтому одиночный кадр
 * альбомом отправить нельзя — это не мелочь, а причина ошибки на обложках.
 *
 * @param {object} bot  бот, от имени которого шлём
 * @param {number|string} chatId
 * @param {number} threadId  топик
 * @param {(string)[]} items  пути к файлам ИЛИ file_id уже загруженных картинок
 * @param {string} [caption]  подпись (ставится к первому кадру)
 * @returns {Promise<string[]>} file_id отправленных картинок — для повторной отправки без загрузки
 */
export async function postPhotos(bot, chatId, threadId, items, caption = '') {
  const cap = caption.slice(0, CAPTION_LIMIT);
  const ids = [];

  for (const chunk of chunked(items, ALBUM_LIMIT)) {
    if (chunk.length === 1) {
      const msg = await bot.api.sendPhoto(chatId, toInput(chunk[0]), {
        message_thread_id: threadId,
        caption: ids.length ? undefined : cap,
      });
      ids.push(largestPhotoId(msg));
      continue;
    }

    const media = chunk.map((item, i) => ({
      type: 'photo',
      media: toInput(item),
      ...(i === 0 && !ids.length && cap ? { caption: cap } : {}),
    }));
    const msgs = await bot.api.sendMediaGroup(chatId, media, { message_thread_id: threadId });
    for (const m of msgs) ids.push(largestPhotoId(m));
  }
  return ids.filter(Boolean);
}

/** Путь к файлу → загрузка; file_id (не похож на путь) → отправка по идентификатору. */
function toInput(item) {
  const s = String(item);
  return path.isAbsolute(s) || /[\\/]/.test(s) ? new InputFile(s) : s;
}

/** Из массива размеров Telegram берём самый крупный — его file_id и переиспользуем. */
function largestPhotoId(msg) {
  const sizes = msg?.photo;
  return Array.isArray(sizes) && sizes.length ? sizes[sizes.length - 1].file_id : null;
}

function* chunked(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
