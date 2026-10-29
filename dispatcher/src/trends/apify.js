// Тонкий клиент Apify REST API (T09). Только транспорт: запустить актор, дождаться, забрать данные.
//
// ПОЧЕМУ ЭТО НЕ НАРУШАЕТ ПРАВИЛО №1. «Node никогда не ходит в API напрямую» — это про Anthropic:
// интеллект идёт только через `claude -p` на подписке клиента. Apify — обычный сторонний сервис
// на отдельном платном аккаунте клиента, ходить в него по HTTP нормально и по-другому нельзя.
//
// Почему не одним вызовом run-sync-get-dataset-items: прогон скрапера легко длится минуты, а
// синхронный эндпоинт обрывается по своему потолку. Здесь честный цикл «запустить → опрашивать →
// забрать», а по нашему дедлайну прогон ABORT-ится: недосчитанный актор не должен молча
// доедать кредиты клиента.

const DEFAULT_BASE_URL = 'https://api.apify.com/v2';
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 300_000;

/** Статусы прогона Apify, после которых ждать больше нечего. */
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

/** Ошибка обращения к Apify с человеческой причиной (её увидит владелец в топике, а не стектрейс). */
export class ApifyError extends Error {
  constructor(message, { status = null, actor = null, runId = null } = {}) {
    super(message);
    this.name = 'ApifyError';
    this.status = status;
    this.actor = actor;
    this.runId = runId;
  }
}

/** `apify/instagram-scraper` → `apify~instagram-scraper` (в URL Apify слэш заменяется тильдой). */
export function actorPath(actorId) {
  return String(actorId || '').trim().replace('/', '~');
}

/** HTTP-код Apify → понятная причина. Всё, что не опознано, отдаётся как есть. */
export function explainStatus(status, body = '') {
  const short = String(body).slice(0, 200);
  if (status === 401 || status === 403) return 'Apify не принял токен — проверь APIFY_TOKEN в .env';
  if (status === 404) return 'актор не найден — проверь id актора (поле actor в trends/sources.json)';
  if (status === 402) return 'на аккаунте Apify закончились кредиты';
  if (status === 429) return 'Apify просит сбавить темп (429) — попробуй позже';
  return `Apify ответил ${status}${short ? `: ${short}` : ''}`;
}

/**
 * Запускает актор, дожидается конца и возвращает элементы его датасета.
 * @param {object} o
 * @param {string} o.token      APIFY_TOKEN (аккаунт клиента)
 * @param {string} o.actorId    id актора, напр. 'apify/instagram-scraper'
 * @param {object} o.input      вход актора (собирается в sources.js)
 * @param {number} [o.maxItems] сколько элементов забрать из датасета
 * @param {number} [o.timeoutMs] общий дедлайн на прогон; по нему актор ABORT-ится
 * @param {number} [o.pollMs]   период опроса статуса
 * @param {string} [o.baseUrl]
 * @param {Function} [o.fetchImpl] инъекция для тестов (default: global fetch)
 * @param {Function} [o.onLog]  колбэк для лога прогресса
 * @returns {Promise<{items:object[], runId:string, datasetId:string, status:string}>}
 */
export async function runActor({
  token,
  actorId,
  input = {},
  maxItems = 100,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  onLog = null,
}) {
  if (!token) throw new ApifyError('не задан APIFY_TOKEN', { actor: actorId });
  if (!actorPath(actorId)) throw new ApifyError('не задан id актора Apify', { actor: actorId });

  const log = (msg) => onLog?.(`[apify] ${msg}`);
  const api = (path, params = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set('token', token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url.toString();
  };

  // 1. Запуск. timeout в секундах — потолок и на стороне Apify, чтобы актор не висел вечно.
  const startRes = await fetchImpl(
    api(`/acts/${actorPath(actorId)}/runs`, { timeout: Math.ceil(timeoutMs / 1000) }),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
  );
  const started = await readJson(startRes, actorId);
  const runId = started?.data?.id;
  const datasetId = started?.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new ApifyError('Apify не вернул id прогона', { actor: actorId });
  log(`прогон ${runId} запущен`);

  // 2. Ожидание. Опрашиваем статус до терминального или до нашего дедлайна.
  const deadline = Date.now() + timeoutMs;
  let status = started.data.status;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      await abortRun({ api, fetchImpl, runId }).catch(() => {});
      throw new ApifyError(`прогон не уложился в ${Math.round(timeoutMs / 1000)} с — остановлен`, {
        actor: actorId,
        runId,
      });
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    const res = await fetchImpl(api(`/actor-runs/${runId}`));
    const body = await readJson(res, actorId);
    status = body?.data?.status || status;
    log(`статус ${status}`);
  }

  if (status !== 'SUCCEEDED') {
    // Частично собранные данные всё же забираем: половина материала лучше пустого отчёта.
    const partial = await fetchItems({ api, fetchImpl, datasetId, maxItems, actorId }).catch(() => []);
    if (!partial.length) {
      throw new ApifyError(`прогон завершился со статусом ${status}`, { actor: actorId, runId });
    }
    log(`статус ${status}, но в датасете есть ${partial.length} элем. — берём их`);
    return { items: partial, runId, datasetId, status };
  }

  // 3. Данные.
  const items = await fetchItems({ api, fetchImpl, datasetId, maxItems, actorId });
  log(`получено элементов: ${items.length}`);
  return { items, runId, datasetId, status };
}

async function fetchItems({ api, fetchImpl, datasetId, maxItems, actorId }) {
  const res = await fetchImpl(api(`/datasets/${datasetId}/items`, { clean: 'true', limit: maxItems }));
  const items = await readJson(res, actorId);
  return Array.isArray(items) ? items : [];
}

async function abortRun({ api, fetchImpl, runId }) {
  await fetchImpl(api(`/actor-runs/${runId}/abort`), { method: 'POST' });
}

/** Ответ Apify → JSON, с превращением HTTP-ошибки в ApifyError с понятной причиной. */
async function readJson(res, actorId) {
  if (!res?.ok) {
    const text = await safeText(res);
    throw new ApifyError(explainStatus(res?.status ?? 0, text), { status: res?.status ?? null, actor: actorId });
  }
  try {
    return await res.json();
  } catch {
    throw new ApifyError('Apify вернул не-JSON', { actor: actorId });
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
