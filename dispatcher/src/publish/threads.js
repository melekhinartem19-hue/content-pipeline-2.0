// Публикация в Threads (T11) — только текст.
//
// Почему только текст: так решено в CLAUDE.md (3 отдельных согласования по площадкам, у Threads
// свой формат). Картинки и видео Threads умеет, но это отдельный трек и отдельное согласование —
// не надо тихо превращать текстовый пост в медийный.
//
// API у Threads СВОЙ: хост graph.threads.net, свой app и свой токен — не тот же, что у Instagram.
// Публикация в два шага, как у всей Meta: создать контейнер → опубликовать его.
//
//   POST /{threads_user_id}/threads          media_type=TEXT&text=…   → creation_id
//   POST /{threads_user_id}/threads_publish  creation_id=…            → id поста

import { createGraphClient } from './graph.js';

/** Лимит поста в Threads. Тихо резать текст нельзя — это уже не то, что одобрил владелец. */
export const THREADS_TEXT_LIMIT = 500;

/** Всё ли настроено для публикации в Threads. */
export function threadsReady(config) {
  const missing = [
    !config?.threadsUserId && 'THREADS_USER_ID',
    !config?.threadsAccessToken && 'THREADS_ACCESS_TOKEN',
  ].filter(Boolean);
  if (missing.length) return { ok: false, error: `не задано в .env: ${missing.join(', ')}` };
  return { ok: true };
}

/**
 * Публикует одобренный текст в Threads клиента.
 * @param {object} o
 * @param {object} o.item   элемент очереди (item.content — одобренный текст)
 * @param {object} o.config конфиг диспетчера
 * @returns {Promise<{ref:string, dryRun:boolean, plan:object[], note:string|null}>}
 */
export async function publishToThreads({ item, config, fetchImpl, onLog = null }) {
  const text = String(item?.content || '').trim();
  if (!text) throw new Error('пустой текст — публиковать нечего');
  if (text.length > THREADS_TEXT_LIMIT) {
    throw new Error(
      `текст ${text.length} знаков, а Threads принимает не больше ${THREADS_TEXT_LIMIT} — ` +
        'сократи через «Правка» и одобри заново',
    );
  }

  const client = createGraphClient({
    baseUrl: config.threadsGraphBaseUrl,
    version: config.metaGraphVersion,
    token: config.threadsAccessToken,
    dryRun: config.publishDryRun,
    fetchImpl,
    onLog,
  });

  const container = await client.post(`${config.threadsUserId}/threads`, { media_type: 'TEXT', text });
  if (!container?.id) throw new Error('Threads не вернул id контейнера');

  const published = await client.post(`${config.threadsUserId}/threads_publish`, { creation_id: container.id });
  if (!published?.id) throw new Error('Threads не вернул id опубликованного поста');

  return { ref: String(published.id), dryRun: client.dryRun, plan: client.plan, note: null };
}
