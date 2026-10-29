// Предполётная проверка публикации (IG + Threads): всё ли настроено ДО первой реальной публикации.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Креды клиента приезжают одним пакетом в день го-лайва, и проверять их
// реальными постами — плохая идея: неудачная попытка либо оставляет мусор в аккаунте, либо даёт
// одну строку ошибки Meta без подсказки, что именно не так. Здесь каждый шаг настройки проверяется
// отдельным безобидным запросом, а ответ переводится в «что делать».
//
// НИЧЕГО НЕ ПУБЛИКУЕТ. Только чтение (GET) плюс один временный файл в публичной статике, который
// тут же удаляется. Поэтому проверка идёт ВСЕГДА по-настоящему, даже при PUBLISH_DRY_RUN=1:
// сухой прогон бережёт аккаунт от публикации, а здесь публиковать нечего.
//
// ЧТО ИМЕННО ЛОВИМ (три ошибки настройки, которые дают почти всю боль на го-лайве):
//   1. Публичная статика не видна снаружи — Instagram скачивает медиа САМ, и без этого не
//      опубликуется ни карусель, ни Reels, каким бы правильным ни был токен.
//   2. В THREADS_* вставлены креды Instagram — у Threads свой API, своё приложение, свой id.
//   3. Токен валиден, но у приложения нет права публикации (App Review мы не проходим, значит
//      аккаунт обязан быть админом/тестером своего же приложения).

import fs from 'node:fs';
import path from 'node:path';
import { createGraphClient } from './graph.js';

/** Подпапка в публичной статике для временного файла проверки. */
const PREFLIGHT_SUBDIR = 'preflight';

/** Сколько ждём ответа от собственной статики: она либо рядом, либо не настроена. */
const STATIC_TIMEOUT_MS = 10_000;

/**
 * Полная проверка готовности к публикации.
 * @param {object} o
 * @param {object} o.config  конфиг диспетчера
 * @returns {Promise<{checks:Array, ig:boolean, threads:boolean}>} ig/threads — можно ли публиковать
 */
export async function preflight({ config, fetchImpl = globalThis.fetch, fsImpl = fs, now = new Date() }) {
  const checks = [];

  checks.push(...(await checkStatic({ config, fetchImpl, fsImpl, now })));
  checks.push(...(await checkInstagram({ config, fetchImpl })));
  checks.push(...(await checkThreads({ config, fetchImpl })));
  checks.push(...checkCrossWiring(config));

  const failed = (area) => checks.some((c) => c.area === area && c.status === 'fail');
  return {
    checks,
    // Карусель без статики не уйдёт, а текст в Threads от статики не зависит — условия разные.
    ig: !failed('ig') && !failed('static'),
    threads: !failed('threads'),
  };
}

/**
 * «/проверка» в топике Издателя — и то же самое словами, без слеша.
 * Проверка ничего не публикует и не тратит вызов claude -p, поэтому список фраз шире, чем у
 * трендов: ложное срабатывание здесь стоит одного безобидного отчёта, а не денег.
 * @returns {{ok:true}|null}
 */
export function parsePreflightCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (/^\/(проверка|проверка_публикации|check|preflight)(?:@\S+)?(?![\p{L}\p{N}_])/su.test(t)) return { ok: true };

  const words =
    /^(проверка|проверка настройки|проверка публикации|проверь настройки|проверь настройку|проверь публикацию|проверь токены|проверь инсту|проверь instagram|проверь threads|preflight)[\s!.?…]*$/u;
  return words.test(t) ? { ok: true } : null;
}

// ── Публичная статика ────────────────────────────────────────────────────

/**
 * Проверка сквозная: записать файл в PUBLIC_DIR и забрать его по PUBLIC_BASE_URL снаружи.
 * Ровно это делает Instagram, когда качает картинку по image_url, поэтому проверять по частям
 * («папка есть», «Nginx запущен») бессмысленно — важен только итог.
 */
async function checkStatic({ config, fetchImpl, fsImpl, now }) {
  const out = [];
  const area = 'static';

  if (!config.publicDir || !config.publicBaseUrl) {
    const missing = [!config.publicDir && 'PUBLIC_DIR', !config.publicBaseUrl && 'PUBLIC_BASE_URL'].filter(Boolean);
    return [
      fail(
        area,
        'Публичная статика',
        `не задано в .env: ${missing.join(', ')}`,
        'Без неё Instagram не опубликует ни карусель, ни Reels: он скачивает медиа по ссылке сам, ' +
          'файл принять не умеет. PUBLIC_DIR — папка, которую раздаёт Nginx, PUBLIC_BASE_URL — её адрес снаружи',
      ),
    ];
  }

  // HTTPS — требование Meta, а не пожелание: по http медиа не заберут.
  if (!/^https:\/\//i.test(config.publicBaseUrl)) {
    out.push(
      fail(
        area,
        'Протокол',
        `PUBLIC_BASE_URL=${config.publicBaseUrl} — не https`,
        'Meta скачивает медиа только по https. Нужен настоящий сертификат, см. deploy/vps-setup.md',
      ),
    );
  }

  const name = `check-${stamp(now)}.txt`;
  const token = `preflight-${Math.random().toString(36).slice(2, 10)}`;
  const dir = path.join(config.publicDir, PREFLIGHT_SUBDIR);
  const file = path.join(dir, name);

  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(file, token, 'utf8');
    out.push(ok(area, 'Запись в PUBLIC_DIR', config.publicDir));
  } catch (err) {
    out.push(
      fail(
        area,
        'Запись в PUBLIC_DIR',
        `${config.publicDir}: ${err.message}`,
        'Папки нет или у пользователя pipeline нет прав на запись: sudo chown -R pipeline:pipeline <папка>',
      ),
    );
    return out;
  }

  const url = `${String(config.publicBaseUrl).replace(/\/+$/, '')}/${PREFLIGHT_SUBDIR}/${name}`;
  try {
    const res = await withTimeout(fetchImpl(url), STATIC_TIMEOUT_MS);
    const body = res.ok ? (await res.text()).trim() : '';
    if (!res.ok) {
      out.push(
        fail(
          area,
          'Файл виден снаружи',
          `${url} → HTTP ${res.status}`,
          'Файл записан, но по ссылке не отдаётся: Nginx смотрит не в ту папку или PUBLIC_BASE_URL не тот адрес. ' +
            'Именно этот запрос делает Instagram — пока он не 200, публикация медиа невозможна',
        ),
      );
    } else if (body !== token) {
      out.push(
        fail(
          area,
          'Файл виден снаружи',
          `${url} → 200, но содержимое чужое`,
          'По адресу отдаётся другой файл (заглушка сайта?) — проверь root в конфиге Nginx',
        ),
      );
    } else {
      out.push(ok(area, 'Файл виден снаружи', `${url} → 200`));
    }
  } catch (err) {
    out.push(
      fail(
        area,
        'Файл виден снаружи',
        `${url}: ${err.message}`,
        'Адрес не отвечает: не поднят Nginx, не прописан DNS или закрыт 443-й порт. Проверять надо ' +
          'снаружи VPS (с телефона по мобильному интернету), а не только из локальной сети',
      ),
    );
  } finally {
    try {
      fsImpl.rmSync(file, { force: true });
    } catch {
      /* временный файл не удалился — не повод валить проверку */
    }
  }

  return out;
}

// ── Instagram ────────────────────────────────────────────────────────────

async function checkInstagram({ config, fetchImpl }) {
  const area = 'ig';
  const missing = [!config.igUserId && 'IG_USER_ID', !config.igAccessToken && 'IG_ACCESS_TOKEN'].filter(Boolean);
  if (missing.length) {
    return [
      fail(
        area,
        'Instagram',
        `не задано в .env: ${missing.join(', ')}`,
        'IG_USER_ID — id бизнес-аккаунта (17841…), токен — long-lived с правами instagram_basic + ' +
          'instagram_content_publish. Аккаунт обязан быть админом/тестером приложения (dev-mode)',
      ),
    ];
  }

  const client = createGraphClient({
    baseUrl: config.igGraphBaseUrl,
    version: config.metaGraphVersion,
    token: config.igAccessToken,
    dryRun: false, // проверка ничего не публикует — сухой прогон ей не нужен
    fetchImpl,
  });
  const out = [];

  // 1) Токен рабочий и указывает на ТОТ аккаунт. Имя в ответе — главная ценность: клиент глазами
  //    видит, в чей Instagram полетят посты, ещё до первой публикации.
  try {
    const account = await client.get(config.igUserId, { fields: 'id,username,media_count,followers_count' });
    out.push(
      ok(area, 'Аккаунт Instagram', `@${account.username ?? '—'} (id ${account.id}, постов ${account.media_count ?? '—'})`),
    );
  } catch (err) {
    out.push(
      fail(
        area,
        'Аккаунт Instagram',
        err.message,
        'Либо токен не тот/протух, либо IG_USER_ID — не id бизнес-аккаунта Instagram (частая путаница: ' +
          'туда вставляют id страницы Facebook или числа из ссылки на профиль)',
      ),
    );
    return out; // дальше спрашивать бессмысленно — всё упрётся в тот же токен
  }

  // 2) Право на публикацию. Эндпоинт лимита требует ровно того же права, что и сама публикация,
  //    но ничего не создаёт — поэтому он и выбран как проверка «опубликовать смогу».
  try {
    const limit = await client.get(`${config.igUserId}/content_publishing_limit`, { fields: 'config,quota_usage' });
    const row = limit?.data?.[0] || {};
    const used = row.quota_usage ?? 0;
    const quota = row.config?.quota_total ?? 50;
    out.push(ok(area, 'Право на публикацию', `есть, за сутки использовано ${used} из ${quota}`));
  } catch (err) {
    out.push(
      fail(
        area,
        'Право на публикацию',
        err.message,
        'Токен читает профиль, но публиковать не может: не выдано instagram_content_publish либо аккаунт ' +
          'не добавлен в приложение как админ/тестер. App Review мы не проходим — работает только dev-mode',
      ),
    );
  }

  out.push(
    await checkTokenLife({ area, config, fetchImpl, token: config.igAccessToken, need: 'instagram_content_publish' }),
  );
  return out.filter(Boolean);
}

// ── Threads ──────────────────────────────────────────────────────────────

async function checkThreads({ config, fetchImpl }) {
  const area = 'threads';
  const missing = [
    !config.threadsUserId && 'THREADS_USER_ID',
    !config.threadsAccessToken && 'THREADS_ACCESS_TOKEN',
  ].filter(Boolean);
  if (missing.length) {
    return [
      fail(
        area,
        'Threads',
        `не задано в .env: ${missing.join(', ')}`,
        'У Threads СВОЁ приложение и свой токен (права threads_basic + threads_content_publish). ' +
          'Токен от Instagram здесь не работает — это самая частая ошибка настройки',
      ),
    ];
  }

  const client = createGraphClient({
    baseUrl: config.threadsGraphBaseUrl,
    version: config.metaGraphVersion,
    token: config.threadsAccessToken,
    dryRun: false,
    fetchImpl,
  });
  const out = [];

  // /me на graph.threads.net отвечает тем аккаунтом, которому принадлежит токен. Сверка с
  // THREADS_USER_ID ловит подстановку чужого id (например, инстаграмного) до первой публикации.
  let me = null;
  try {
    me = await client.get('me', { fields: 'id,username' });
  } catch (err) {
    out.push(
      fail(
        area,
        'Аккаунт Threads',
        err.message,
        'Токен не принят API Threads. Он выпускается в ОТДЕЛЬНОМ приложении Threads (graph.threads.net), ' +
          'токен Instagram сюда не подходит',
      ),
    );
    return out;
  }

  if (String(me.id) !== String(config.threadsUserId)) {
    out.push(
      fail(
        area,
        'Аккаунт Threads',
        `токен принадлежит id ${me.id}, а в .env THREADS_USER_ID=${config.threadsUserId}`,
        'Впиши в THREADS_USER_ID то, что вернул API (обычно туда по ошибке попадает id Instagram)',
      ),
    );
  } else {
    out.push(ok(area, 'Аккаунт Threads', `@${me.username ?? '—'} (id ${me.id})`));
  }

  try {
    const limit = await client.get(`${config.threadsUserId}/threads_publishing_limit`, {
      fields: 'quota_usage,config',
    });
    const row = limit?.data?.[0] || {};
    const used = row.quota_usage ?? 0;
    const quota = row.config?.quota_total ?? 250;
    out.push(ok(area, 'Право на публикацию', `есть, за сутки использовано ${used} из ${quota}`));
  } catch (err) {
    out.push(
      fail(
        area,
        'Право на публикацию',
        err.message,
        'Не выдано threads_content_publish либо аккаунт не тестер приложения Threads',
      ),
    );
  }

  return out;
}

// ── Срок жизни токена (необязательная проверка) ──────────────────────────

/**
 * Сколько токену осталось жить и какие у него права. Требует META_APP_ID/META_APP_SECRET —
 * без них Meta не отдаёт debug_token. Проверка необязательная, но важная для передачи клиенту:
 * long-lived токен живёт 60 дней, и «всё вдруг перестало публиковаться через два месяца» — это
 * почти всегда он. Без секретов приложения шаг просто пропускается.
 */
async function checkTokenLife({ area, config, fetchImpl, token, need }) {
  if (!config.metaAppId || !config.metaAppSecret) {
    return skip(
      area,
      'Срок жизни токена',
      'пропущено: не заданы META_APP_ID / META_APP_SECRET',
      'Необязательно, но полезно: с ними проверка покажет дату истечения токена и выданные права',
    );
  }

  const client = createGraphClient({
    baseUrl: config.igGraphBaseUrl,
    version: config.metaGraphVersion,
    token: `${config.metaAppId}|${config.metaAppSecret}`,
    dryRun: false,
    fetchImpl,
  });

  try {
    const res = await client.get('debug_token', { input_token: token });
    const d = res?.data || {};
    const scopes = Array.isArray(d.scopes) ? d.scopes : [];

    if (need && scopes.length && !scopes.includes(need)) {
      return fail(
        area,
        'Права токена',
        `нет ${need} (выдано: ${scopes.join(', ') || '—'})`,
        'Выпусти токен заново, отметив это право при выдаче',
      );
    }
    if (!d.expires_at) return ok(area, 'Срок жизни токена', 'бессрочный');

    const days = Math.round((d.expires_at * 1000 - Date.now()) / 86_400_000);
    const when = new Date(d.expires_at * 1000).toLocaleDateString('ru-RU');
    if (days <= 14) {
      return warn(
        area,
        'Срок жизни токена',
        `истекает через ${days} дн. (${when})`,
        'Выпусти long-lived токен заново — иначе публикация встанет молча',
      );
    }
    return ok(area, 'Срок жизни токена', `ещё ${days} дн. (до ${when})`);
  } catch (err) {
    return warn(
      area,
      'Срок жизни токена',
      `не удалось проверить: ${err.message}`,
      'На публикацию не влияет — проверь META_APP_ID/META_APP_SECRET',
    );
  }
}

// ── Перекрёстные ошибки настройки ────────────────────────────────────────

/** Один и тот же токен в обеих площадках — верный признак, что креды Threads не выпускали. */
function checkCrossWiring(config) {
  const out = [];
  if (config.igAccessToken && config.igAccessToken === config.threadsAccessToken) {
    out.push(
      fail(
        'threads',
        'Токены площадок',
        'IG_ACCESS_TOKEN и THREADS_ACCESS_TOKEN совпадают',
        'У Threads отдельное приложение и отдельный токен. Скопированный токен Instagram может даже ' +
          'пройти часть проверок, но публикация упадёт',
      ),
    );
  }
  if (config.igUserId && config.igUserId === config.threadsUserId) {
    out.push(
      fail(
        'threads',
        'Id площадок',
        'IG_USER_ID и THREADS_USER_ID совпадают',
        'Это разные аккаунты в разных API — id Instagram в Threads не работает',
      ),
    );
  }
  return out;
}

// ── Отчёт ────────────────────────────────────────────────────────────────

const AREA_TITLES = {
  static: 'ПУБЛИЧНАЯ СТАТИКА (без неё нет ни карусели, ни Reels)',
  ig: 'INSTAGRAM (карусели, обложки, Reels)',
  threads: 'THREADS (только текст)',
};

const ICONS = { ok: '✅', warn: '⚠️', fail: '⛔', skip: '➖' };

/** Результат проверки → текст для топика Издателя или консоли. */
export function renderPreflight(result) {
  const lines = ['🔎 Предполётная проверка публикации', ''];

  for (const [area, title] of Object.entries(AREA_TITLES)) {
    const rows = result.checks.filter((c) => c.area === area);
    if (!rows.length) continue;
    lines.push(title);
    for (const c of rows) {
      lines.push(`${ICONS[c.status]} ${c.name}: ${c.detail}`);
      if (c.hint && c.status !== 'ok') lines.push(`   → ${c.hint}`);
    }
    lines.push('');
  }

  lines.push(
    result.ig ? '✅ Instagram: можно публиковать' : '⛔ Instagram: публиковать нельзя',
    result.threads ? '✅ Threads: можно публиковать' : '⛔ Threads: публиковать нельзя',
    '',
    'Ничего не опубликовано — это была только проверка настройки.',
  );
  return lines.join('\n');
}

// ── Мелочи ───────────────────────────────────────────────────────────────

const ok = (area, name, detail) => ({ area, name, detail, status: 'ok', hint: null });
const warn = (area, name, detail, hint) => ({ area, name, detail, status: 'warn', hint });
const fail = (area, name, detail, hint) => ({ area, name, detail, status: 'fail', hint });
const skip = (area, name, detail, hint) => ({ area, name, detail, status: 'skip', hint });

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Своя статика либо отвечает быстро, либо не настроена — вечно ждать нечего. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`нет ответа за ${ms / 1000} с`)), ms)),
  ]);
}
