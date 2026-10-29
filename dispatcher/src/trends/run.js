// Прогон сбора трендов (T09): источники → Apify → дедуп → Разведчик → темы в БД.
//
// Модуль НИЧЕГО не знает про Telegram: он возвращает готовый текст отчёта, а кто и куда его
// запостит — дело вызывающего (команда «/тренды» отвечает в тот же чат, планировщик пишет в топик
// Разведчика). Так же устроен рендер визуала: логика отдельно, I/O отдельно.
//
// Порядок шагов важен и завязан на деньги клиента:
//   1) конфиг источников  — нет файла, значит ничего не тратим;
//   2) лимит «1 прогон/день» — из БД, перезапуск процесса его не обнуляет;
//   3) сбор через провайдера (Apify);
//   4) дедуп по ссылке — уже разобранные посты не уходят Разведчику второй раз (экономия claude -p);
//   5) Разведчик (claude -p) кластеризует материал в темы;
//   6) темы в БД, отчёт наружу.

import { runAgent } from '../agent.js';
import { buildDigest, parseTopicsFromMeta, topPosts } from './normalize.js';
import { getProvider } from './providers.js';
import { enabledPlatforms, limitsOf, loadSources } from './sources.js';

/** Кого зовём разбирать материал (файл agents/scout.md). */
export const SCOUT_AGENT = 'scout';

/** Локальная дата YYYY-MM-DD — по ней считается «прогон за сутки». */
export function todayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Локальное время HH:MM — по нему срабатывает суточный автозапуск. */
export function hhmm(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Команда сбора: со слешем и словами ────────────────────────────────────
//
// ПОЧЕМУ ФРАЗА РАСПОЗНАЁТСЯ ЦЕЛИКОМ, А НЕ ПО ВХОЖДЕНИЮ СЛОВА. Прогон актора Apify стоит денег,
// поэтому «тренды» внутри живой фразы («расскажи про тренды в нише», «какие тренды заходят») —
// это НЕ команда, а задача Разведчику, и она уходит в claude -p как раньше. Командой считается
// только сообщение, целиком состоящее из глагола-приказа, слова «тренды» и, возможно, слова
// обхода суточного лимита. Лишнее слово — значит разговор, а не приказ.

/** Глаголы-приказы, после которых «тренды» — команда, а не тема разговора. */
const TRENDS_VERBS = [
  'собери', 'собрать', 'собирай',
  'обнови', 'обновить',
  'проверь', 'проверить',
  'запусти', 'запустить',
  'покажи', 'показать', 'дай', 'глянь', 'посмотри',
  'найди', 'поищи',
].join('|');

/** Само слово: падежи, единственное число и латиница — на случай непереключённой раскладки. */
const TRENDS_NOUN = 'тренды|тренд|тренда|трендов|trends';

/** Осознанный обход суточного лимита. Только явные слова: восклицательный знак — не приказ. */
const TRENDS_FORCE = 'сейчас|силой|срочно|снова|заново|повторно|now|force';

/**
 * «/тренды», «/тренды сейчас» — и то же самое словами, без слеша («тренды», «собери тренды»).
 * @returns {{force:boolean, plain:boolean}|null}  plain — распознано словами, без слеша
 */
export function parseTrendsCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/ё/g, 'е');

  // Форма со слешем. \b по кириллице не работает (в JS это граница только для латиницы) —
  // поэтому lookahead с \p{L}. (?:@\S+)? — форма «/тренды@бот», которую Telegram даёт в группах.
  const slash = /^\/(тренды|trends)(?:@\S+)?(?![\p{L}\p{N}_])(.*)$/su.exec(t);
  if (slash) return { force: /(сейчас|силой|force|now|!)/.test(slash[2]), plain: false };

  // Форма словами: [глагол] тренды [сейчас]. Знаки в конце не мешают, лишние слова — запрещают.
  const words = new RegExp(
    String.raw`^(?:(?:${TRENDS_VERBS})\s+)?(?:${TRENDS_NOUN})(?:\s+(?:${TRENDS_FORCE}))?[\s!.?…]*$`,
    'u',
  );
  if (!words.test(t)) return null;
  return { force: new RegExp(TRENDS_FORCE, 'u').test(t), plain: true };
}

/**
 * Один прогон сбора.
 * @param {object} o
 * @param {object} o.db              фасад БД (нужен db.trends)
 * @param {object} o.config          конфиг диспетчера (токен Apify, путь к источникам, провайдер)
 * @param {object} [o.provider]      инъекция провайдера сбора (для тестов)
 * @param {Function} [o.agentRunner] инъекция вызова агента (для тестов)
 * @param {Function} [o.fetchImpl]   инъекция fetch (для тестов)
 * @param {boolean} [o.force]        обойти суточный лимит («/тренды сейчас»)
 * @returns {Promise<{ok:boolean, status:'ok'|'empty'|'failed'|'skipped', runId:number|null,
 *   found:number, added:number, topics:number, report:string|null, summary:string,
 *   notes:string[], error:string|null}>}
 */
export async function runTrends({
  db,
  config,
  provider = null,
  agentRunner = runAgent,
  fetchImpl = globalThis.fetch,
  force = false,
  now = new Date(),
  onLog = null,
}) {
  const day = todayStamp(now);
  const log = (m) => onLog?.(m);

  // 1. Источники. Не настроены — это не поломка, а «клиент ещё не заполнил».
  const loaded = loadSources(config.trendsSourcesPath);
  if (!loaded.ok) return skipped(loaded.error);

  const sources = loaded.sources;
  const limits = limitsOf(sources);
  const platforms = enabledPlatforms(sources).map((p) => p.platform);

  // 2. Лимит суток. Держит и от лишних трат на Apify, и от лишнего внимания площадок.
  const runsToday = db.trends.countRunsOnDay(day);
  if (!force && runsToday >= limits.runsPerDay) {
    return skipped(
      `лимит суток исчерпан: сегодня уже ${runsToday} прогон(ов) из ${limits.runsPerDay}. ` +
        'Осознанно повторить — «/тренды сейчас».',
    );
  }

  // 3. Провайдер сбора (apify — основной, login — резерв варианта C, не реализован).
  let source;
  try {
    source = provider || getProvider(config.trendsProvider);
  } catch (err) {
    return skipped(err.message);
  }
  const ready = source.available({ config, sources });
  if (!ready.ok) return skipped(ready.error);

  const runId = db.trends.startRun({ day, provider: source.name });
  log(`[trends] прогон #${runId}: площадки ${platforms.join(', ') || '—'}`);

  let collected;
  try {
    collected = await source.collect({ sources, config, fetchImpl, onLog });
  } catch (err) {
    db.trends.finishRun(runId, { status: 'failed', note: err.message });
    return {
      ok: false,
      status: 'failed',
      runId,
      found: 0,
      added: 0,
      topics: 0,
      report: null,
      summary: `⚠️ Сбор не удался: ${err.message}`,
      notes: [],
      error: err.message,
    };
  }

  const notes = collected.notes || [];
  const found = collected.posts.length;

  // 4. Дедуп. Пишем всё, что собрали; INSERT OR IGNORE оставит только невиданное — оно и пойдёт
  //    Разведчику. Так один и тот же пост не оплачивается вызовом claude -p дважды.
  const capped = topPosts(collected.posts, limits.maxPostsPerRun);
  const { added } = db.trends.addPosts(runId, capped);
  const fresh = db.trends.listPostsByRun(runId, { limit: limits.maxPostsPerRun });
  log(`[trends] собрано ${found}, новых ${added}`);

  if (!fresh.length) {
    const note = found ? 'нового с прошлого прогона не появилось' : 'сбор вернул пусто';
    db.trends.finishRun(runId, { status: 'empty', postsFound: found, postsNew: 0, note: joinNotes(notes, note) });
    return {
      ok: true,
      status: 'empty',
      runId,
      found,
      added: 0,
      topics: 0,
      report: null,
      summary: `🔎 Прогон #${runId}: собрано ${found}, новых 0 — ${note}.`,
      notes,
      error: null,
    };
  }

  // 5. Разведчик кластеризует. Материал уже нормализован — агенту не надо разбирать сырьё актора.
  const posts = fresh.map(fromRow);
  const task = buildScoutTask({ posts, platforms, day, provider: source.name, sources });
  const res = await agentRunner({ agentKey: SCOUT_AGENT, task });

  if (!res.ok) {
    // Посты уже сохранены — материал не потерян, повтор разбора не заставит платить Apify заново.
    db.trends.finishRun(runId, {
      status: 'failed',
      postsFound: found,
      postsNew: added,
      note: joinNotes(notes, `Разведчик не ответил: ${res.error}`),
    });
    return {
      ok: false,
      status: 'failed',
      runId,
      found,
      added,
      topics: 0,
      report: null,
      summary: `⚠️ Собрано ${added} новых постов, но Разведчик не ответил: ${res.error}`,
      notes,
      error: res.error,
    };
  }

  // 6. Темы в БД, отчёт наружу.
  const topics = parseTopicsFromMeta(res.meta);
  db.trends.addTopics(runId, topics);
  db.trends.finishRun(runId, {
    status: 'ok',
    postsFound: found,
    postsNew: added,
    topicsFound: topics.length,
    note: joinNotes(notes),
  });

  const report = [
    `🔎 Тренды за ${day} · собрано ${found}, новых ${added} · источник: ${source.name}`,
    '',
    res.content,
  ].join('\n');

  return {
    ok: true,
    status: 'ok',
    runId,
    found,
    added,
    topics: topics.length,
    report,
    summary: `🔎 Прогон #${runId}: собрано ${found}, новых ${added}, тем ${topics.length}.`,
    notes,
    error: null,
  };

  /** Прогон не начинался: ничего не потрачено, причина понятна человеку. */
  function skipped(reason) {
    return {
      ok: false,
      status: 'skipped',
      runId: null,
      found: 0,
      added: 0,
      topics: 0,
      report: null,
      summary: `ℹ️ Сбор не запущен: ${reason}`,
      notes: [],
      error: reason,
    };
  }
}

/** Задача Разведчику: та же роль и тот же формат ответа, что и при ручном разборе. */
export function buildScoutTask({ posts, platforms, day, provider, sources }) {
  const counts = {};
  for (const p of posts) counts[p.platform] = (counts[p.platform] || 0) + 1;

  const targets = enabledPlatforms(sources || {})
    .flatMap(({ platform, cfg }) =>
      [
        ...(cfg.accounts || []).map((a) => `@${String(a).replace(/^@/, '')}`),
        ...(cfg.hashtags || []).map((h) => `#${String(h).replace(/^#/, '')}`),
      ].map((s) => `${platform}:${s}`),
    )
    .join(', ');

  const breakdown = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');

  return [
    'Разбери собранный материал соцсетей и выдай кластеры тем строго по своему формату вывода.',
    '',
    `Дата сбора: ${day}. Собрано автоматически (${provider}), площадки: ${platforms.join(', ') || '—'}.`,
    `Постов в материале: ${posts.length}${breakdown ? ` (${breakdown})` : ''}.`,
    targets ? `Источники: ${targets}.` : null,
    'Это НОВЫЕ посты — ранее разобранные исключены дедупом, повторов прошлых отчётов не будет.',
    '',
    'МАТЕРИАЛ:',
    buildDigest(posts),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Суточный автозапуск. Никакого cron: раз в несколько минут смотрим, наступило ли время TRENDS_AT
 * и не было ли прогона сегодня. Состояние — в БД, поэтому перезапуск процесса ничего не ломает,
 * а пропущенный из-за простоя прогон уйдёт, как только диспетчер снова поднимется в тот же день.
 * @returns {() => void} остановка таймера
 */
export function startTrendsScheduler({ db, config, intervalMs = 5 * 60_000, onDone = null, onLog = null, ...deps }) {
  const tick = async () => {
    if (!config.trendsAt) return; // автозапуск не настроен — работает только ручной «/тренды»
    const now = new Date();
    if (hhmm(now) < String(config.trendsAt)) return;
    if (db.trends.countRunsOnDay(todayStamp(now)) > 0) return;

    const res = await runTrends({ db, config, now, onLog, ...deps });
    if (onDone) await onDone(res);
  };

  const timer = setInterval(() => {
    tick().catch((err) => console.error('[trends] tick error:', err));
  }, intervalMs);
  timer.unref?.(); // сбор трендов не должен сам по себе держать процесс живым

  return () => clearInterval(timer);
}

/** Строка БД → пост в том же виде, в каком его собрал нормализатор (для дайджеста). */
function fromRow(row) {
  return {
    platform: row.platform,
    url: row.url,
    author: row.author,
    text: row.text || '',
    likes: row.likes,
    comments: row.comments,
    views: row.views,
    postedAt: row.posted_at,
    sourceQuery: row.source_query,
  };
}

function joinNotes(notes = [], extra = null) {
  const all = [...notes, extra].filter(Boolean);
  return all.length ? all.join('; ') : null;
}
