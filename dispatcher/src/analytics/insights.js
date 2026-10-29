// Метрики опубликованного из Instagram и Threads (T16, необязательная часть Аналитика).
//
// ЭТО ДОПОЛНЕНИЕ, А НЕ ОСНОВА. Отчёт Аналитика работает и без метрик — на фактах собственной базы
// (report.js). Инсайты требуют ОТДЕЛЬНЫХ прав в Meta (`instagram_manage_insights`,
// `threads_manage_insights`), а App Review мы не проходим (правило 2 в CLAUDE.md). В dev-mode на
// СОБСТВЕННЫХ аккаунтах клиента они выдаются, но это его решение и его настройка — поэтому сбор
// выключен по умолчанию и включается флагом ANALYTICS_INSIGHTS=1.
//
// ЧТО СЧИТАЕТСЯ УСПЕХОМ. Метрика пришла — записали снимок (по строке на замер, миграция 010).
// Не пришла (нет прав, пост слишком свежий, Meta ответила ошибкой) — это НЕ авария: отчёт выйдет
// без цифр площадки, а причина будет видна в отчёте о сборе. Аналитика не должна ронять конвейер.
//
// TELEGRAM ЗДЕСЬ НЕТ. Bot API не отдаёт просмотры постов канала, а гонять за ними отдельный
// user-клиент мы не будем: это чужая сессия и лишний риск. По TG считаем то, что знаем сами.

import { createGraphClient } from '../publish/graph.js';

/** Метрики, которые спрашиваем у Instagram. У Reels добавляется просмотр видео. */
const IG_METRICS = {
  reels: ['views', 'reach', 'likes', 'comments', 'saved', 'shares'],
  post: ['reach', 'likes', 'comments', 'saved', 'shares'],
};

/** Метрики Threads. Свой API, свой набор — общего с Instagram здесь ничего нет. */
const THREADS_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];

/** Виды контента, у которых в Instagram метрики видео. */
const REELS_KINDS = new Set(['reels_video', 'reels_script']);

/** Можно ли вообще собирать метрики: включено ли и есть ли чем. */
export function insightsReady(config) {
  if (!config?.analyticsInsights) {
    return {
      ok: false,
      error:
        'сбор метрик выключен. Включается ANALYTICS_INSIGHTS=1 — и только если у токенов клиента ' +
        'есть права *_manage_insights (в dev-mode на своих аккаунтах их выдают)',
    };
  }
  if (!config.igAccessToken && !config.threadsAccessToken) {
    return { ok: false, error: 'нет ни одного токена площадки — собирать метрики нечем' };
  }
  return { ok: true };
}

/**
 * Собирает метрики по опубликованному за период и складывает снимки в БД.
 * @param {object} o
 * @param {object} o.db  фасад БД
 * @param {object[]} o.posts  опубликованное из collectFacts(): { id, platform, kind, ref }
 * @returns {Promise<{ok:boolean, collected:number, skipped:number, errors:string[], error?:string}>}
 */
export async function collectInsights({ db, posts, config, fetchImpl = globalThis.fetch, onLog = null }) {
  const ready = insightsReady(config);
  if (!ready.ok) return { ok: false, collected: 0, skipped: posts.length, errors: [], error: ready.error };

  const clients = {
    ig: config.igAccessToken
      ? createGraphClient({
          baseUrl: config.igGraphBaseUrl,
          version: config.metaGraphVersion,
          token: config.igAccessToken,
          dryRun: config.publishDryRun,
          fetchImpl,
          onLog,
        })
      : null,
    threads: config.threadsAccessToken
      ? createGraphClient({
          baseUrl: config.threadsGraphBaseUrl,
          version: config.metaGraphVersion,
          token: config.threadsAccessToken,
          dryRun: config.publishDryRun,
          fetchImpl,
          onLog,
        })
      : null,
  };

  let collected = 0;
  let skipped = 0;
  const errors = [];

  for (const post of posts) {
    // TG считаем сами, а без id поста на площадке спрашивать не о чем.
    if (post.platform === 'tg' || !post.ref) {
      skipped += 1;
      continue;
    }
    const client = clients[post.platform];
    if (!client) {
      skipped += 1;
      continue;
    }

    const metric =
      post.platform === 'threads'
        ? THREADS_METRICS
        : REELS_KINDS.has(post.kind)
          ? IG_METRICS.reels
          : IG_METRICS.post;

    try {
      const body = await client.get(`${post.ref}/insights`, { metric: metric.join(',') });
      const metrics = parseInsights(body);
      if (Object.keys(metrics).length) {
        db.metrics.add({ queueId: post.id, platform: post.platform, ref: post.ref, metrics });
        collected += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      // Частое и нормальное: у токена нет права на инсайты, пост моложе суток, метрика снята Meta.
      skipped += 1;
      errors.push(`#${post.id} (${post.platform}): ${err.message}`);
    }
  }

  return { ok: true, collected, skipped, errors };
}

/**
 * Ответ инсайтов → плоский объект { имя: число }.
 * Форматы у площадок разные и меняются между версиями Graph API, поэтому разбираем терпимо:
 * `values[0].value` (Instagram) и `total_value.value` (Threads), что найдётся — то и берём.
 */
export function parseInsights(body) {
  const out = {};
  for (const row of body?.data || []) {
    const name = row?.name;
    if (!name) continue;
    const value = row?.total_value?.value ?? row?.values?.[0]?.value;
    if (typeof value === 'number') out[name] = value;
  }
  return out;
}

/** Отчёт о сборе — короткая строка под фактами в топике Аналитика. */
export function renderInsightsNote(res) {
  if (!res.ok) return `ℹ️ Метрики площадок не собирались: ${res.error}`;
  const lines = [`📈 Метрики собраны: ${res.collected} · пропущено: ${res.skipped}`];
  if (res.errors.length) {
    lines.push(`⚠️ Не отдали метрики (${res.errors.length}):`, ...res.errors.slice(0, 5).map((e) => `  ${e}`));
  }
  return lines.join('\n');
}
