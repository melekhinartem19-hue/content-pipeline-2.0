// Публикация в Instagram (T12): карусель, одиночная обложка, Reels — через Graph API в dev-mode.
//
// Три вещи, которые определяют весь код ниже:
//
//  1. IG НЕ ПРИНИМАЕТ ФАЙЛ. Он принимает `image_url`/`video_url` и скачивает медиа сам. Поэтому
//     отрендеренные в T10 PNG сначала выкладываются в публичную статику (media.js), и только
//     потом ссылки уходят в Meta. Без PUBLIC_BASE_URL публикация невозможна в принципе.
//  2. Публикация всегда в два (для карусели — в три) шага: контейнер(ы) → контейнер поста →
//     media_publish. Промежуточные id живут ~24 часа.
//  3. Карусель — от 2 до 10 элементов. Один кадр публикуется как обычный пост, 11-й кадр IG не
//     примет (тот же лимит, что и у Telegram на media-group — совпадение удобное, но не случайное).
//
// Подпись берётся из META агента (`caption`), а НЕ из item.content: у карусели content — это
// спецификация слайдов Дизайнера, ей в подписи к посту не место.

import { createGraphClient } from './graph.js';
import { imageUrlsFor, localImages, mediaReady } from './media.js';

/** Лимит подписи к посту в Instagram. */
export const IG_CAPTION_LIMIT = 2200;

/** Границы карусели Instagram. */
export const IG_CAROUSEL_MIN = 2;
export const IG_CAROUSEL_MAX = 10;

/** Всё ли настроено для публикации в Instagram. */
export function igReady(config) {
  const missing = [!config?.igUserId && 'IG_USER_ID', !config?.igAccessToken && 'IG_ACCESS_TOKEN'].filter(Boolean);
  if (missing.length) return { ok: false, error: `не задано в .env: ${missing.join(', ')}` };
  return { ok: true };
}

/** Подпись к посту: её даёт агент в META. Нет подписи — публикуем без неё, но говорим об этом. */
export function pickCaption(item) {
  for (const key of ['caption', 'ig_caption', 'post_text']) {
    const v = item?.meta?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Публикует одобренный элемент в Instagram клиента.
 * @param {object} o
 * @param {object} o.item   элемент очереди (meta.images — кадры из T10, meta.video_url — готовый Reels)
 * @param {object} o.config конфиг диспетчера
 * @returns {Promise<{ref?:string, dryRun?:boolean, plan?:object[], note?:string|null,
 *   skip?:boolean, reason?:string}>}
 */
export async function publishToInstagram({ item, config, fetchImpl, onLog = null, sleep = defaultSleep }) {
  const caption = pickCaption(item);
  if (caption.length > IG_CAPTION_LIMIT) {
    throw new Error(`подпись ${caption.length} знаков, а Instagram принимает ${IG_CAPTION_LIMIT} — сократи`);
  }

  const client = () =>
    createGraphClient({
      baseUrl: config.igGraphBaseUrl,
      version: config.metaGraphVersion,
      token: config.igAccessToken,
      dryRun: config.publishDryRun,
      fetchImpl,
      onLog,
    });

  // ── Reels: нужен готовый ролик, а его монтирует ноут клиента (T15) ──────
  const videoUrl = typeof item?.meta?.video_url === 'string' ? item.meta.video_url.trim() : '';
  if (item.kind === 'reels_script' || videoUrl) {
    if (!videoUrl) {
      return {
        skip: true,
        reason:
          'это сценарий Reels, а не готовый ролик: публиковать нечего. Ролик монтируется на ноуте ' +
          'клиента (T15) и приезжает в meta.video_url публичной ссылкой',
      };
    }
    return publishReels({ client: client(), config, videoUrl, caption, sleep });
  }

  // ── Карусель или обложка: сначала кадры должны стать публичными ссылками ─
  if (!localImages(item.meta).length && !item?.meta?.image_urls?.length) {
    return {
      skip: true,
      reason: 'нет картинок: сначала рендер (T10). Повторить — «/рендер <id>» в топике Дизайнера',
    };
  }

  const ready = mediaReady(config);
  if (!ready.ok && !item?.meta?.image_urls?.length) throw new Error(ready.error);

  const { urls, source } = imageUrlsFor({ item, config });
  if (!urls.length) throw new Error('картинки есть, но публичных ссылок на них не получилось');
  if (urls.length > IG_CAROUSEL_MAX) {
    throw new Error(`кадров ${urls.length}, а карусель Instagram принимает не больше ${IG_CAROUSEL_MAX}`);
  }

  const c = client();
  const note = [
    caption ? null : 'подписи нет (META агента без поля caption) — пост уйдёт без текста',
    source === 'meta' ? 'ссылки взяты из META, копирование в статику не понадобилось' : null,
  ]
    .filter(Boolean)
    .join('; ');

  const creationId =
    urls.length >= IG_CAROUSEL_MIN
      ? await createCarousel({ client: c, config, urls, caption })
      : await createSingle({ client: c, config, url: urls[0], caption });

  const published = await c.post(`${config.igUserId}/media_publish`, { creation_id: creationId });
  if (!published?.id) throw new Error('Instagram не вернул id опубликованного поста');

  return { ref: String(published.id), dryRun: c.dryRun, plan: c.plan, note: note || null };
}

/** Одиночный кадр (обложка) — обычный пост с картинкой. */
async function createSingle({ client, config, url, caption }) {
  const res = await client.post(`${config.igUserId}/media`, { image_url: url, caption: caption || undefined });
  if (!res?.id) throw new Error('Instagram не вернул id контейнера картинки');
  return res.id;
}

/** Карусель: контейнер на каждый кадр, затем контейнер-карусель с их списком. */
async function createCarousel({ client, config, urls, caption }) {
  const children = [];
  for (const url of urls) {
    const child = await client.post(`${config.igUserId}/media`, { image_url: url, is_carousel_item: 'true' });
    if (!child?.id) throw new Error('Instagram не вернул id контейнера кадра');
    children.push(child.id);
  }
  const carousel = await client.post(`${config.igUserId}/media`, {
    media_type: 'CAROUSEL',
    children: children.join(','),
    caption: caption || undefined,
  });
  if (!carousel?.id) throw new Error('Instagram не вернул id контейнера карусели');
  return carousel.id;
}

/**
 * Reels: видео Meta обрабатывает асинхронно, публиковать контейнер можно только после FINISHED.
 * Поэтому здесь единственное место с ожиданием — без него publish упадёт на «media not ready».
 */
async function publishReels({ client, config, videoUrl, caption, sleep }) {
  const container = await client.post(`${config.igUserId}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption || undefined,
  });
  if (!container?.id) throw new Error('Instagram не вернул id контейнера Reels');

  const attempts = config.igStatusAttempts ?? 36;
  const pollMs = config.igPollMs ?? 5_000;
  for (let i = 0; i < attempts; i += 1) {
    const st = await client.get(container.id, { fields: 'status_code' });
    const code = String(st?.status_code || '');
    if (code === 'FINISHED') break;
    if (code === 'ERROR') throw new Error('Instagram не смог обработать видео (status_code=ERROR)');
    if (i === attempts - 1) {
      // Не «видео плохое», а «ждали недостаточно». Говорим, сколько именно ждали, — иначе
      // ошибка выглядит как отказ Instagram, и ролик начинают перемонтировать на ровном месте.
      throw new Error(
        `Instagram всё ещё обрабатывает видео — ждали ${Math.round((attempts * pollMs) / 1000)} с. ` +
          'Нажми «Одобрить» ещё раз через пару минут (ролик зальётся заново и успеет обработаться) ' +
          'или увеличь IG_STATUS_ATTEMPTS в .env',
      );
    }
    await sleep(pollMs);
  }

  const published = await client.post(`${config.igUserId}/media_publish`, { creation_id: container.id });
  if (!published?.id) throw new Error('Instagram не вернул id опубликованного Reels');
  return { ref: String(published.id), dryRun: client.dryRun, plan: client.plan, note: null };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
