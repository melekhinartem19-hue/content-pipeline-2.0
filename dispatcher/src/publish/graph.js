// Общий транспорт для Meta Graph API (T11 Threads, T12 Instagram).
//
// Здесь только HTTP и перевод ошибок Meta на человеческий язык. Никакой логики публикации —
// она в threads.js и instagram.js, потому что у площадок разные хосты, токены и шаги.
//
// ПРАВИЛО 2 ИЗ CLAUDE.md: App Review в Meta мы не проходим. Значит — только dev-mode: приложение
// клиента, клиент админ/тестер, публикация исключительно в его собственные аккаунты. Никаких
// прав, требующих ревью, здесь не запрашивается.
//
// Токен уходит в теле формы, а не в URL: так он не оседает в логах прокси и в истории редиректов.

/** Ошибка Graph API с разобранной причиной (её увидит владелец в топике Издателя). */
export class GraphError extends Error {
  constructor(message, { status = null, code = null, subcode = null, type = null, trace = null } = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.trace = trace;
  }
}

/** Коды Meta, которые стоит объяснять словами, а не показывать номером. */
const CODE_HINTS = {
  190: 'токен доступа недействителен или истёк — выпусти long-lived токен заново',
  102: 'сессия недействительна — нужен новый токен',
  10: 'приложению не хватает прав. App Review мы не проходим: аккаунт должен быть в приложении ' +
    'как админ/тестер (dev-mode), а токен выпущен под него',
  200: 'нет прав на это действие: проверь, что аккаунт — админ/тестер приложения и это ЕГО аккаунт',
  4: 'превышен лимит запросов приложения — попробуй позже',
  17: 'превышен лимит запросов пользователя — попробуй позже',
  32: 'превышен лимит страницы — попробуй позже',
  9004: 'Meta не смогла скачать картинку по image_url. Ссылка должна быть публичной и по HTTPS ' +
    '(см. PUBLIC_BASE_URL и Nginx-статику)',
  2207026: 'формат видео не принят Instagram',
  2207003: 'Meta не смогла скачать медиа по ссылке — проверь доступность URL',
};

/**
 * Клиент Graph API одной площадки.
 * @param {object} o
 * @param {string} o.baseUrl   хост API: graph.facebook.com (IG) или graph.threads.net (Threads)
 * @param {string} o.version   версия API, напр. v21.0
 * @param {string} o.token     access token аккаунта клиента
 * @param {boolean} [o.dryRun] сухой прогон: запросы не уходят, а копятся в plan
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.onLog]
 */
export function createGraphClient({ baseUrl, version, token, dryRun = false, fetchImpl = globalThis.fetch, onLog = null }) {
  const plan = [];
  let dryCounter = 0;

  return {
    dryRun,
    plan,

    /** POST на Graph API. В сухом прогоне возвращает фиктивный id и записывает шаг в plan. */
    async post(path, params = {}) {
      const url = `${trim(baseUrl)}/${version}/${String(path).replace(/^\//, '')}`;
      const safeParams = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
      plan.push({ method: 'POST', url, params: safeParams });
      onLog?.(`[graph] POST ${url} ${JSON.stringify(safeParams).slice(0, 300)}`);
      if (dryRun) return { id: `dry-${++dryCounter}` };

      const body = new URLSearchParams({ ...safeParams, access_token: token });
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      return readGraph(res);
    },

    /** GET на Graph API (нужен, чтобы дождаться готовности контейнера Reels). */
    async get(path, params = {}) {
      const url = new URL(`${trim(baseUrl)}/${version}/${String(path).replace(/^\//, '')}`);
      for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
      plan.push({ method: 'GET', url: url.toString(), params });
      if (dryRun) return { status_code: 'FINISHED' };

      url.searchParams.set('access_token', token);
      const res = await fetchImpl(url.toString());
      return readGraph(res);
    },
  };
}

/** Ответ Graph → JSON, ошибка Meta → GraphError с понятной причиной. */
async function readGraph(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res?.ok || body?.error) {
    throw toGraphError(res?.status ?? 0, body);
  }
  return body ?? {};
}

/** Тело ошибки Meta → GraphError. Код объясняем словами, служебное (fbtrace) сохраняем в поле. */
export function toGraphError(status, body) {
  const e = body?.error || {};
  const code = e.code ?? null;
  const hint = CODE_HINTS[code] || CODE_HINTS[e.error_subcode] || null;
  const base = e.message || `Graph API ответил ${status}`;
  return new GraphError(hint ? `${base} — ${hint}` : base, {
    status,
    code,
    subcode: e.error_subcode ?? null,
    type: e.type ?? null,
    trace: e.fbtrace_id ?? null,
  });
}

/** Человеческое описание сухого прогона: что ушло бы в Meta. */
export function describePlan(plan = []) {
  return plan.map((step, i) => `${i + 1}. ${step.method} ${shortUrl(step.url)}`).join('\n');
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url);
  }
}

function trim(s) {
  return String(s || '').replace(/\/+$/, '');
}
