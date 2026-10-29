// Источники сбора (T09): что читаем из trends/sources.json и как из этого получается вход актора.
//
// Разделение ответственности: ЧТО смотреть — данные клиента (видимый JSON в trends/), КАК это
// уложить в конкретный актор — тоже данные (поле request), а код лишь склеивает. Причина простая:
// актор в Apify Store может подорожать или сломаться, клиент возьмёт другой — и у него другие имена
// полей на входе. Замена актора не должна означать правку кода.

import fs from 'node:fs';

/** Площадки, которые вообще бывают в конфиге. Всё остальное — опечатка клиента. */
export const PLATFORMS = ['ig', 'threads'];

/** Значения по умолчанию: применяются, если клиент не задал своё. */
export const DEFAULT_LIMITS = { runsPerDay: 1, postsPerSource: 12, maxPostsPerRun: 60 };

/** Как из имени аккаунта/хэштега получается ссылка. Переопределяется в конфиге (urlTemplates). */
export const DEFAULT_URL_TEMPLATES = {
  ig: {
    account: 'https://www.instagram.com/{value}/',
    hashtag: 'https://www.instagram.com/explore/tags/{value}/',
  },
  threads: {
    account: 'https://www.threads.net/@{value}',
    hashtag: 'https://www.threads.net/search?q={value}&serp_type=tags',
  },
};

/** Имя поля со ссылками во входе актора, если клиент не указал своё. */
const DEFAULT_URLS_FIELD = 'directUrls';

/**
 * Читает и проверяет trends/sources.json.
 * Отсутствие файла — НЕ ошибка кода, а «клиент ещё не настроил»: возвращаем ok:false с внятным
 * текстом, который можно показать в топик, и ничего не тратим.
 * @returns {{ok:boolean, sources?:object, error?:string, path:string}}
 */
export function loadSources(file, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!exists(file)) {
    return {
      ok: false,
      path: file,
      error:
        'источники не настроены: нет trends/sources.json. Скопируй trends/sources.example.json → ' +
        'trends/sources.json и впиши свои аккаунты (см. trends/README.md).',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFile(file, 'utf8'));
  } catch (err) {
    return { ok: false, path: file, error: `trends/sources.json не читается как JSON: ${err.message}` };
  }
  const check = validateSources(parsed);
  if (!check.ok) return { ok: false, path: file, error: check.error };
  return { ok: true, path: file, sources: parsed };
}

/** Проверка структуры: важно поймать «включил площадку, но не вписал актор» ДО траты денег. */
export function validateSources(sources) {
  if (!sources || typeof sources !== 'object') return { ok: false, error: 'пустой конфиг источников' };
  const platforms = sources.platforms;
  if (!platforms || typeof platforms !== 'object') {
    return { ok: false, error: 'в конфиге нет секции platforms' };
  }
  const unknown = Object.keys(platforms).filter((k) => !k.startsWith('_') && !PLATFORMS.includes(k));
  if (unknown.length) {
    return { ok: false, error: `неизвестные площадки: ${unknown.join(', ')} (бывают только ${PLATFORMS.join(', ')})` };
  }
  for (const platform of PLATFORMS) {
    const cfg = platforms[platform];
    if (!cfg || cfg.enabled !== true) continue;
    if (!String(cfg.actor || '').trim()) {
      return { ok: false, error: `площадка «${platform}» включена, но не задан actor (id актора Apify)` };
    }
    if (!targetsOf(cfg).length) {
      return { ok: false, error: `площадка «${platform}» включена, но не задано ни одного accounts/hashtags` };
    }
  }
  if (!enabledPlatforms(sources).length) {
    return { ok: false, error: 'ни одна площадка не включена (enabled: true) — собирать нечего' };
  }
  return { ok: true };
}

/** Лимиты с подстановкой значений по умолчанию. */
export function limitsOf(sources) {
  const raw = sources?.limits || {};
  return {
    runsPerDay: positive(raw.runsPerDay, DEFAULT_LIMITS.runsPerDay),
    postsPerSource: positive(raw.postsPerSource, DEFAULT_LIMITS.postsPerSource),
    maxPostsPerRun: positive(raw.maxPostsPerRun, DEFAULT_LIMITS.maxPostsPerRun),
  };
}

/** Список включённых площадок: [{platform, cfg}]. */
export function enabledPlatforms(sources) {
  return PLATFORMS.filter((p) => sources?.platforms?.[p]?.enabled === true).map((platform) => ({
    platform,
    cfg: sources.platforms[platform],
  }));
}

/** Цели площадки: аккаунты и хэштеги → [{type, value, url}]. `@` и `#` срезаются. */
export function buildTargets(cfg, platform) {
  const templates = { ...DEFAULT_URL_TEMPLATES[platform], ...(cfg?.urlTemplates || {}) };
  return targetsOf(cfg).map(({ type, value }) => ({
    type,
    value,
    url: String(templates[type] || '').replace('{value}', encodeURIComponent(value)),
  }));
}

/**
 * Вход актора: цели-ссылки + лимит + произвольные поля клиента (request.extra).
 * Имена полей приходят из конфига — под разные акторы они разные.
 */
export function buildActorInput(cfg, targets, { postsPerSource = DEFAULT_LIMITS.postsPerSource } = {}) {
  const req = cfg?.request || {};
  const urlsField = String(req.urlsField || DEFAULT_URLS_FIELD);
  const input = { ...stripHints(req.extra || {}) };
  input[urlsField] = targets.map((t) => t.url);
  if (req.limitField) input[String(req.limitField)] = postsPerSource;
  return input;
}

/** Актор площадки: .env перебивает файл — так клиенту не надо редактировать JSON ради смены актора. */
export function actorFor(cfg, platform, envActors = {}) {
  return String(envActors?.[platform] || cfg?.actor || '').trim();
}

/** Ссылка → её цель (аккаунт/хэштег), чтобы у поста осталось «откуда он». */
export function sourceQueryFor(targets, url) {
  const hit = targets.find((t) => t.url === url);
  return hit ? `${hit.type === 'hashtag' ? '#' : '@'}${hit.value}` : null;
}

function targetsOf(cfg) {
  const list = (arr, type, strip) =>
    (Array.isArray(arr) ? arr : [])
      .map((v) => String(v || '').trim().replace(strip, ''))
      .filter(Boolean)
      .map((value) => ({ type, value }));
  return [...list(cfg?.accounts, 'account', /^@/), ...list(cfg?.hashtags, 'hashtag', /^#/)];
}

/** Убирает ключи-подсказки («_», «_comment») — они для человека, не для актора. */
function stripHints(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));
}

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
