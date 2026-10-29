// Клиент ManyChat API и синхронизация трёх ссылок воронки (T14).
//
// ЧТО ЗДЕСЬ ПРОИСХОДИТ. Диспетчер записывает публичные ссылки на PDF в bot-поля ManyChat:
//
//   funnel_pdfs.url ──▶ POST /fb/page/setBotFieldByName ──▶ поле pdf_<ключ>
//                                                              │
//                       флоу в директе: «Держи материал — {{pdf_content_plan}}»
//
// Флоу, кнопки и триггеры собирает человек в UI ManyChat: их API создавать не умеет (см. карточку
// настройки в reply.js). Наша зона ответственности — держать в полях актуальные ссылки.
//
// ПОЧЕМУ ЭТО НЕ НАРУШАЕТ ПРАВИЛО №1 CLAUDE.md. «Node никогда не ходит в API напрямую» — это про
// Anthropic: интеллект только через `claude -p` на подписке клиента. ManyChat — обычный сторонний
// сервис на отдельном аккаунте клиента, ходить в него по HTTP нормально и по-другому нельзя.
// Никакого «интеллекта» здесь нет: матчинг темы — три ключа, без ИИ-классификации (правило CLAUDE.md).
//
// ГДЕ ТУТ ГРАБЛИ. Путь `/fb/…` в ManyChat историчен: приставка осталась от Facebook-времён, а
// эндпоинты одни на все каналы, включая Instagram. Если ManyChat поменяет схему путей, правится
// одна константа PATHS ниже плюс MANYCHAT_API_URL в .env — код трогать не придётся.

import { loadFunnel } from './config.js';
import { funnelSettings, funnelView } from './reply.js';

/** Базовый адрес API ManyChat. */
export const DEFAULT_API_URL = 'https://api.manychat.com';

/** Эндпоинты. Единственное место, где зашита схема путей ManyChat. */
export const PATHS = {
  botFields: '/fb/page/getBotFields',
  createBotField: '/fb/page/createBotField',
  setBotFieldByName: '/fb/page/setBotFieldByName',
};

/** Ошибка обращения к ManyChat с человеческой причиной (её увидит владелец в топике). */
export class ManychatError extends Error {
  constructor(message, { status = null, path = null } = {}) {
    super(message);
    this.name = 'ManychatError';
    this.status = status;
    this.path = path;
  }
}

/** HTTP-код ManyChat → понятная причина. Всё неопознанное отдаётся как есть. */
export function explainStatus(status, body = '') {
  const short = String(body).slice(0, 200);
  if (status === 401) return 'ManyChat не принял ключ — проверь MANYCHAT_TOKEN в .env (Settings → API)';
  if (status === 403) {
    return 'ManyChat отказал в доступе: API доступен только на платном тарифе (Pro) и с ключом того же аккаунта';
  }
  if (status === 404) return `ManyChat не знает такого эндпоинта (${short || 'проверь MANYCHAT_API_URL'})`;
  if (status === 422) return `ManyChat не принял данные: ${short || 'проверь имя поля'}`;
  if (status === 429) return 'ManyChat просит сбавить темп (429) — повтори через минуту';
  return `ManyChat ответил ${status}${short ? `: ${short}` : ''}`;
}

/**
 * Тонкий клиент ManyChat API. Только транспорт: авторизация, разбор ответа, перевод ошибок.
 *
 * @param {object} o
 * @param {string} o.token       MANYCHAT_TOKEN (аккаунт клиента)
 * @param {string} [o.baseUrl]
 * @param {boolean} [o.dryRun]   сухой прогон: запросы не уходят, а копятся в plan
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.onLog]
 */
export function createManychatClient({
  token,
  baseUrl = DEFAULT_API_URL,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  onLog = null,
}) {
  const plan = [];
  const url = (p) => `${String(baseUrl).replace(/\/$/, '')}${p}`;

  async function call(method, path, body = null) {
    plan.push({ method, path, body });
    onLog?.(`[manychat] ${method} ${path} ${body ? JSON.stringify(body).slice(0, 200) : ''}`);
    if (dryRun) return { dry: true };

    if (!token) throw new ManychatError('не задан MANYCHAT_TOKEN', { path });

    let res;
    try {
      res = await fetchImpl(url(path), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // Сеть/DNS: на VPS это обычно закрытый исходящий трафик, а не поломка ManyChat.
      throw new ManychatError(`не достучались до ManyChat: ${err.message}`, { path });
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Не JSON — почти всегда страница ошибки прокси; текст пригодится в причине.
    }

    if (!res.ok) throw new ManychatError(explainStatus(res.status, json?.message || text), { status: res.status, path });
    // ManyChat умеет ответить 200 со status:"error" — это тоже отказ, а не успех.
    if (json && json.status && json.status !== 'success') {
      throw new ManychatError(`ManyChat отказал: ${json.message || 'причина не указана'}`, { status: res.status, path });
    }
    return json?.data ?? json ?? {};
  }

  return {
    dryRun,
    plan,

    /** Список существующих bot-полей. Нужен, чтобы не пытаться писать в несуществующее поле. */
    async botFields() {
      const data = await call('GET', PATHS.botFields);
      if (dryRun) return null; // в сухом прогоне список неизвестен — и это честнее, чем выдумать
      const list = Array.isArray(data) ? data : data?.fields || [];
      return list.map((f) => String(f.name || f.field_name || '')).filter(Boolean);
    },

    /** Создать текстовое bot-поле (если клиент не завёл его руками). */
    async createBotField({ name, description = '', value = null }) {
      return call('POST', PATHS.createBotField, { name, type: 'text', description, value });
    },

    /** Записать значение в поле по ИМЕНИ — id полей нам знать не нужно. */
    async setBotFieldByName({ name, value }) {
      return call('POST', PATHS.setBotFieldByName, { field_name: name, field_value: value });
    },
  };
}

/**
 * Состояние воронки: конфиг тем + собранные PDF из БД → готовая картина для отчётов и синхронизации.
 * Единственное место, где читаются файл и база: дальше всё живёт на чистых функциях reply.js,
 * поэтому и команда «/воронка», и «/воронка синх» показывают ровно одно и то же.
 *
 * @returns {{ok:boolean, view?:object[], settings?:object, note?:string|null, error?:string}}
 */
export function funnelSnapshot({ db, config }) {
  const funnel = loadFunnel(config.funnelConfigPath);
  if (!funnel.ok) return { ok: false, error: funnel.error };

  const settings = funnelSettings(funnel.manychat);
  const view = funnelView({
    topics: funnel.topics,
    rows: db.funnel.list(),
    prefix: config.manychatFieldPrefix,
    settings,
  });
  return { ok: true, view, settings, note: funnel.note || null };
}

/**
 * Синхронизация: три ссылки на PDF → три bot-поля ManyChat.
 *
 * Правило то же, что у сборки PDF: сбой одной темы не отменяет остальные — каждая тема считается
 * отдельно, а причины уезжают в отчёт. Тема без ссылки пропускается: писать в поле пустоту хуже,
 * чем оставить прежнюю рабочую ссылку.
 *
 * @param {object} o
 * @param {object} o.db      фасад БД (нужен db.funnel)
 * @param {object} o.config  конфиг диспетчера
 * @param {string|null} [o.key]  синхронизировать одну тему
 * @param {Function} [o.clientFactory] инъекция для тестов (default: createManychatClient)
 * @param {Function} [o.onLog]
 * @returns {Promise<{ok:boolean, results:object[], note:string|null, error:string|null, dryRun:boolean}>}
 */
export async function syncFunnelFields({
  db,
  config,
  key = null,
  clientFactory = createManychatClient,
  onLog = () => {},
}) {
  const dryRun = Boolean(config.manychatDryRun);
  const snapshot = funnelSnapshot({ db, config });
  if (!snapshot.ok) return { ok: false, results: [], note: null, error: snapshot.error, dryRun };

  if (!config.manychatToken && !dryRun) {
    return {
      ok: false,
      results: [],
      note: null,
      dryRun,
      error:
        'не задан MANYCHAT_TOKEN в .env (ManyChat → Settings → API). Пока его нет, ссылки можно ' +
        'вставить во флоу руками — «/воронка настройка».',
    };
  }

  let view = snapshot.view;

  if (key) {
    const needle = String(key).trim().toLowerCase();
    const one = view.find((t) => t.key.toLowerCase() === needle || t.keyword?.toLowerCase() === needle);
    if (!one) {
      return {
        ok: false,
        results: [],
        note: null,
        dryRun,
        error: `темы «${key}» нет в manychat/funnel.json (есть: ${view.map((t) => t.key).join(', ')})`,
      };
    }
    view = [one];
  }

  const client = clientFactory({
    token: config.manychatToken,
    baseUrl: config.manychatApiUrl,
    dryRun,
    onLog,
  });

  // Список полей запрашиваем ОДИН раз: понять, какие поля надо создать. Если список недоступен
  // (тариф, права), не сдаёмся — просто пишем в поля вслепую и говорим об этом в отчёте.
  let existing = null;
  let listWarn = null;
  try {
    existing = await client.botFields();
  } catch (err) {
    listWarn = `список полей ManyChat не прочитался (${err.message}) — поля не создаём, пишем в существующие`;
  }

  const results = [];
  for (const t of view) {
    const result = { key: t.key, title: t.title, field: t.field, value: t.value, status: 'skipped', error: null };

    if (!t.value) {
      // Ссылки нет — в поле не лезем: пустое значение в ManyChat сломает уже работающий флоу.
      result.error = t.warns[0] || 'нет ссылки на PDF';
      results.push(result);
      continue;
    }

    try {
      if (existing && !existing.includes(t.field)) {
        onLog(`[manychat] поля ${t.field} нет — создаю`);
        await client.createBotField({ name: t.field, description: `Ссылка на PDF: ${t.title}`, value: t.value });
        result.status = 'created';
      }
      await client.setBotFieldByName({ name: t.field, value: t.value });
      if (result.status !== 'created') result.status = 'set';
      if (!dryRun) db.funnel.markSynced({ key: t.key, field: t.field, url: t.value });
    } catch (err) {
      result.status = 'failed';
      result.error = err.message;
    }
    results.push(result);
  }

  const note = [snapshot.note, listWarn].filter(Boolean).join(' · ') || null;
  return { ok: results.some((r) => r.status === 'set' || r.status === 'created'), results, note, error: null, dryRun };
}

/** Отчёт о синхронизации для топика Презентатора. Чистая функция — её проверяет смоук. */
export function renderSyncReport({ results, note = null, error = null, dryRun = false }) {
  if (error) return `⚠️ Синхронизация с ManyChat не пошла: ${error}`;
  if (!results.length) return '⚠️ Синхронизировать нечего: в конфиге воронки нет тем.';

  const lines = [dryRun ? '🧪 Сухой прогон синхронизации (в ManyChat ничего не ушло):' : '🔗 Синхронизация с ManyChat:'];
  for (const r of results) {
    if (r.status === 'failed') {
      lines.push(`  ⚠️ ${r.title} (${r.field}) — ${r.error}`);
      continue;
    }
    if (r.status === 'skipped') {
      lines.push(`  ⏭ ${r.title} (${r.field}) — пропущена: ${r.error}`);
      continue;
    }
    lines.push(`  ✅ ${r.field}${r.status === 'created' ? ' (поле создано)' : ''}`);
    lines.push(`     ${r.value}`);
  }

  const done = results.filter((r) => r.status === 'set' || r.status === 'created').length;
  lines.push(`Записано полей: ${done} из ${results.length}.`);
  if (note) lines.push(`ℹ️ ${note}`);
  if (done && !dryRun) {
    lines.push('Во флоу ManyChat ссылка подставляется как {{имя_поля}} — карточка настройки: «/воронка настройка».');
  }
  return lines.join('\n');
}
