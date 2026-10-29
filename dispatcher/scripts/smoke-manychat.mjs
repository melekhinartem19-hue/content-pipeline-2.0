// Смоук-тест инста-воронки ManyChat (T14): три ключа → три разные ссылки на PDF.
// Оффлайн: аккаунта ManyChat у нас нет и не будет (он клиентский), поэтому здесь проверяется
// вся логика воронки на чистых функциях — тексты, имена полей, матчинг ключей, карточка настройки.
// Запуск: node dispatcher/scripts/smoke-manychat.mjs
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { validateFunnel } from '../src/funnel/config.js';
import {
  ManychatError,
  PATHS,
  createManychatClient,
  explainStatus,
  renderSyncReport,
  syncFunnelFields,
} from '../src/funnel/manychat.js';
import {
  BUTTON_LIMIT,
  DEFAULT_FIELD_PREFIX,
  botFieldName,
  buttonLabel,
  funnelReply,
  funnelSettings,
  funnelView,
  parseFunnelCommand,
  renderFunnelState,
  renderFunnelTest,
  renderSetupCard,
} from '../src/funnel/reply.js';

// ── Команда ───────────────────────────────────────────────────────────────
assert.deepEqual(parseFunnelCommand('/воронка'), { action: 'state', key: null }, 'состояние воронки');
assert.deepEqual(parseFunnelCommand('воронка синх'), { action: 'sync', key: null }, 'синхронизация без слэша');
assert.equal(parseFunnelCommand('/funnel sync').action, 'sync', 'латинский вариант');
assert.equal(parseFunnelCommand('/воронка настройка').action, 'setup', 'карточка настройки');
assert.deepEqual(parseFunnelCommand('/воронка тест план'), { action: 'test', key: 'план' }, 'репетиция по ключу');
assert.deepEqual(parseFunnelCommand('/воронка план'), { action: 'test', key: 'план' }, 'слово «тест» необязательно');
assert.equal(parseFunnelCommand('воронка продаж у нас так себе'), null, 'похожий текст командой не считается');

// ── Конфиг: ключевые слова и подписи кнопок ───────────────────────────────
const dup = validateFunnel({
  topics: [
    { key: 'a', title: 'A', brief: 'b', keyword: 'план' },
    { key: 'b', title: 'B', brief: 'b', keyword: 'План' },
  ],
});
assert.equal(dup.ok, false, 'два одинаковых ключевых слова — ошибка');
assert.match(dup.error, /стоит у двух тем/, 'и объясняет, почему так нельзя');

const okCfg = validateFunnel({
  topics: [{ key: 'content-plan', title: 'Контент-план на месяц за один час', brief: 'б', keyword: 'план', button: 'План' }],
});
assert.equal(okCfg.ok, true, 'конфиг с кнопкой принят');
assert.equal(okCfg.topics[0].button, 'План', 'подпись кнопки прочитана');
assert.equal(buttonLabel(okCfg.topics[0]), 'План', 'кнопка своя');
assert.equal(
  buttonLabel({ title: 'Длинное название темы', button: null }),
  'Длинное название темы',
  'без своей подписи берётся название темы',
);

// ── Имя bot-поля ManyChat ─────────────────────────────────────────────────
assert.equal(botFieldName('content-plan'), 'pdf_content_plan', 'дефис → подчёркивание, префикс на месте');
assert.equal(botFieldName('reels-hooks', 'lead_'), 'lead_reels_hooks', 'префикс настраивается');
assert.equal(DEFAULT_FIELD_PREFIX, 'pdf_', 'префикс по умолчанию');

// ── Текст ответа в директ ─────────────────────────────────────────────────
const topics = [
  { key: 'content-plan', title: 'Контент-план за час', brief: 'б', keyword: 'план', button: 'План', pages: 6 },
  { key: 'reels-hooks', title: 'Крючки для Reels', brief: 'б', keyword: 'reels', button: 'Reels', pages: 6 },
  { key: 'sales-posts', title: 'Продающий пост', brief: 'б', keyword: 'продажи', button: 'Продажи', pages: 6 },
];
const rows = [
  { key: 'content-plan', title: 'Контент-план за час', url: 'https://media.example.com/funnel/content-plan.pdf', built_at: '2026-09-07 10:00' },
  { key: 'reels-hooks', title: 'Крючки для Reels', url: 'https://media.example.com/funnel/reels-hooks.pdf', built_at: '2026-09-07 10:02' },
  { key: 'sales-posts', title: 'Продающий пост', url: 'https://media.example.com/funnel/sales-posts.pdf', built_at: '2026-09-07 10:04' },
];

const settings = funnelSettings({ replyTemplate: 'Держи материал по теме «{title}» — {url}' });
const one = funnelReply({ topic: topics[0], url: rows[0].url, settings });
assert.equal(one.source, 'pdf', 'ссылка на PDF');
assert.match(one.text, /Контент-план за час/, 'название темы подставлено');
assert.match(one.text, /content-plan\.pdf/, 'ссылка подставлена');
assert.equal(one.warn, null, 'предупреждений нет');

// Своя разметка шаблона: подставляются {title}/{url}/{keyword}/{button}, остальное не трогаем.
const custom = funnelReply({
  topic: topics[1],
  url: rows[1].url,
  settings: funnelSettings({ replyTemplate: '{button}: {url} (ключ {keyword}) {unknown}' }),
});
assert.equal(custom.text, 'Reels: https://media.example.com/funnel/reels-hooks.pdf (ключ reels) {unknown}', 'подстановка точная');

// Ссылки нет и увода в Telegram нет — честно говорим, что отдавать нечего.
const empty = funnelReply({ topic: topics[0], url: null, settings });
assert.equal(empty.text, '', 'текст не выдумывается');
assert.equal(empty.source, 'none', 'источника нет');
assert.match(empty.warn, /PDF ещё не собран/, 'причина названа');

// Увод в Telegram — штатный запасной путь (галка тикета «ссылка ИЛИ увод в Telegram»).
const tg = funnelReply({
  topic: topics[0],
  url: null,
  settings: funnelSettings({ fallbackTelegram: 'https://t.me/example_bot' }),
});
assert.equal(tg.source, 'telegram', 'ушли в Telegram');
assert.match(tg.text, /t\.me\/example_bot/, 'в тексте ссылка на Telegram');
assert.match(tg.warn, /уводим в Telegram/, 'и это названо вслух');

// ── Свод «конфиг + собранные PDF» ─────────────────────────────────────────
const view = funnelView({ topics, rows, settings });
assert.equal(view.length, 3, 'по элементу на тему');
assert.deepEqual(
  view.map((t) => t.field),
  ['pdf_content_plan', 'pdf_reels_hooks', 'pdf_sales_posts'],
  'три РАЗНЫХ поля ManyChat',
);
assert.equal(new Set(view.map((t) => t.url)).size, 3, 'три ключа ведут на три разные ссылки');
assert.ok(view.every((t) => t.warns.length === 0), 'настроенная воронка не жалуется');
assert.match(view[0].flowText, /\{\{pdf_content_plan\}\}/, 'во флоу подставляется поле, а не голая ссылка');
assert.match(view[0].reply, /content-plan\.pdf/, 'а человеку уходит настоящая ссылка');

// Тема без собранного PDF: элемент есть, ссылки нет, причина названа.
const partial = funnelView({ topics, rows: rows.slice(0, 2), settings });
assert.equal(partial[2].url, null, 'третьей ссылки нет');
assert.match(partial[2].warns.join(' '), /PDF ещё не собран/, 'и сказано, что сделать');

// Длинная подпись кнопки и отсутствие ключевого слова — предупреждения, а не падение.
const sloppy = funnelView({
  topics: [{ key: 'a', title: 'Очень длинное название темы для кнопки', brief: 'б', keyword: null, button: null }],
  rows: [{ key: 'a', url: 'https://x/a.pdf' }],
  settings,
});
assert.ok(sloppy[0].button.length > BUTTON_LIMIT, 'подпись действительно длинная');
assert.match(sloppy[0].warns.join(' '), /подпись кнопки длиннее/, 'про лимит кнопки сказано');
assert.match(sloppy[0].warns.join(' '), /нет ключевого слова/, 'про пустой keyword сказано');

// ── Отчёты в топик ────────────────────────────────────────────────────────
const state = renderFunnelState(view, { hasToken: false });
assert.match(state, /pdf_content_plan/, 'видно имя поля ManyChat');
assert.match(state, /Готово к выдаче: 3 из 3/, 'виден итог');
assert.match(state, /MANYCHAT_TOKEN не задан/, 'без токена подсказывает ручной путь');
assert.match(renderFunnelState(view, { hasToken: true }), /воронка синх/, 'с токеном зовёт синхронизировать');
assert.match(renderFunnelState(view, { hasToken: true, dryRun: true }), /DRY_RUN/, 'сухой прогон виден');

const card = renderSetupCard(view, { hasToken: true });
for (const t of view) {
  assert.ok(card.includes(t.field), `в карточке есть поле ${t.field}`);
  assert.ok(card.includes(`«${t.button}»`), `в карточке есть кнопка ${t.button}`);
  assert.ok(card.includes(t.keyword), `в карточке есть ключевое слово ${t.keyword}`);
}
assert.match(card, /Bot Fields/, 'шаг про поля на месте');
assert.match(card, /Keywords/, 'шаг про ключевые слова на месте');
assert.match(card, /Файл-PDF в инста-директ отправить нельзя/, 'гоча площадки записана прямо в карточке');
assert.match(renderSetupCard(partial, {}), /Без ссылки пока: sales-posts/, 'карточка честно говорит, чего не хватает');

// ── Репетиция: три ключа ведут на три разных PDF ──────────────────────────
const hits = ['план', 'reels', 'продажи'].map((k) => renderFunnelTest(view, k));
assert.match(hits[0], /content-plan\.pdf/, '«план» → свой PDF');
assert.match(hits[1], /reels-hooks\.pdf/, '«reels» → свой PDF');
assert.match(hits[2], /sales-posts\.pdf/, '«продажи» → свой PDF');
assert.ok(!hits[0].includes('reels-hooks.pdf'), 'ключи не путаются между собой');
assert.match(renderFunnelTest(view, 'content-plan'), /content-plan\.pdf/, 'ключ темы тоже работает');
assert.match(renderFunnelTest(view, 'ПЛАН'), /content-plan\.pdf/, 'регистр не важен — пишет человек');
assert.match(renderFunnelTest(view, 'чтотоещё'), /воронка ничего не отдаст/, 'чужой ключ — честный отказ');
assert.match(renderFunnelTest(view, ''), /Укажи ключевое слово/, 'пустой запрос подсказывает формат');

// ── Клиент ManyChat: транспорт и перевод отказов ──────────────────────────
// Аккаунта ManyChat у нас нет (он клиентский), поэтому вместо сети — подставной fetch.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    const route = routes[path];
    if (!route) return { ok: false, status: 404, text: async () => 'not found' };
    return typeof route === 'function' ? route(calls.at(-1)) : route;
  };
  impl.calls = calls;
  return impl;
}
const jsonOk = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data }) });

const okRoutes = {
  [PATHS.botFields]: jsonOk([{ name: 'pdf_content_plan' }, { name: 'pdf_reels_hooks' }, { name: 'pdf_sales_posts' }]),
  [PATHS.setBotFieldByName]: jsonOk({}),
  [PATHS.createBotField]: jsonOk({ id: 1 }),
};

const fetchImpl = fakeFetch(okRoutes);
const client = createManychatClient({ token: 'secret', fetchImpl });
assert.deepEqual(await client.botFields(), ['pdf_content_plan', 'pdf_reels_hooks', 'pdf_sales_posts'], 'список полей');
await client.setBotFieldByName({ name: 'pdf_content_plan', value: 'https://x/a.pdf' });
const setCall = fetchImpl.calls.at(-1);
assert.equal(setCall.method, 'POST', 'запись — POST');
assert.deepEqual(setCall.body, { field_name: 'pdf_content_plan', field_value: 'https://x/a.pdf' }, 'тело запроса');
assert.equal(setCall.headers.authorization, 'Bearer secret', 'ключ уходит заголовком, а не в URL');

// Отказы переводятся на человеческий: владелец должен понять, что чинить, без гугла.
for (const [status, re] of [
  [401, /не принял ключ/],
  [403, /платном тарифе/],
  [429, /сбавить темп/],
  [500, /ответил 500/],
]) {
  const bad = createManychatClient({
    token: 't',
    fetchImpl: fakeFetch({ [PATHS.setBotFieldByName]: { ok: false, status, text: async () => '{}' } }),
  });
  await assert.rejects(
    () => bad.setBotFieldByName({ name: 'f', value: 'v' }),
    (err) => err instanceof ManychatError && re.test(err.message),
    `статус ${status} объяснён словами`,
  );
}
assert.match(explainStatus(422, 'bad field'), /не принял данные/, 'валидация тоже объяснена');

// ManyChat умеет ответить 200 со status:"error" — это отказ, а не успех.
const sneaky = createManychatClient({
  token: 't',
  fetchImpl: fakeFetch({
    [PATHS.setBotFieldByName]: { ok: true, status: 200, text: async () => '{"status":"error","message":"no field"}' },
  }),
});
await assert.rejects(() => sneaky.setBotFieldByName({ name: 'f', value: 'v' }), /ManyChat отказал: no field/, '200 с ошибкой');

// ── Синхронизация трёх ссылок ─────────────────────────────────────────────
const funnelFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-mc-')), 'funnel.json');
await fsp.writeFile(
  funnelFile,
  JSON.stringify({
    topics: topics.map(({ key, title, keyword, button }) => ({ key, title, keyword, button, brief: 'б' })),
    manychat: { replyTemplate: 'Держи материал по теме «{title}» — {url}' },
  }),
  'utf8',
);

function syncStand(routes = okRoutes, { token = 'secret', dryRun = false } = {}) {
  const db = openDb(':memory:');
  for (const r of rows) db.funnel.upsert({ key: r.key, title: r.title, file: `/tmp/${r.key}.pdf`, url: r.url, pages: 5 });
  const impl = fakeFetch(routes);
  const cfg = {
    funnelConfigPath: funnelFile,
    manychatToken: token,
    manychatApiUrl: 'https://api.manychat.com',
    manychatFieldPrefix: 'pdf_',
    manychatDryRun: dryRun,
  };
  const clientFactory = (o) => createManychatClient({ ...o, fetchImpl: impl });
  return { db, impl, cfg, clientFactory };
}

const s1 = syncStand();
const sync = await syncFunnelFields({ db: s1.db, config: s1.cfg, clientFactory: s1.clientFactory });
assert.equal(sync.ok, true, 'синхронизация прошла');
assert.equal(sync.results.length, 3, 'по результату на тему');
assert.ok(sync.results.every((r) => r.status === 'set'), 'все три поля записаны');
const written = s1.impl.calls.filter((c) => c.path === PATHS.setBotFieldByName).map((c) => c.body);
assert.equal(new Set(written.map((b) => b.field_name)).size, 3, 'три РАЗНЫХ поля');
assert.equal(new Set(written.map((b) => b.field_value)).size, 3, 'и три РАЗНЫЕ ссылки');
assert.equal(s1.db.funnel.getByKey('content-plan').manychat_url, rows[0].url, 'записанное значение запомнено в БД');
assert.ok(s1.db.funnel.getByKey('content-plan').manychat_at, 'и время синхронизации тоже');
assert.match(renderSyncReport(sync), /Записано полей: 3 из 3/, 'отчёт считает честно');

// Поля в ManyChat ещё нет — создаём сами, чтобы клиенту не заводить его руками.
const s2 = syncStand({ ...okRoutes, [PATHS.botFields]: jsonOk([{ name: 'pdf_content_plan' }]) });
const created = await syncFunnelFields({ db: s2.db, config: s2.cfg, clientFactory: s2.clientFactory });
assert.equal(created.results.filter((r) => r.status === 'created').length, 2, 'два недостающих поля созданы');
assert.equal(created.results.filter((r) => r.status === 'set').length, 1, 'существующее просто перезаписано');
assert.match(renderSyncReport(created), /поле создано/, 'в отчёте это видно');

// Список полей недоступен (тариф/права) — не сдаёмся, пишем вслепую и говорим об этом.
const s3 = syncStand({ ...okRoutes, [PATHS.botFields]: { ok: false, status: 403, text: async () => '{}' } });
const blind = await syncFunnelFields({ db: s3.db, config: s3.cfg, clientFactory: s3.clientFactory });
assert.equal(blind.ok, true, 'ссылки всё равно записаны');
assert.match(blind.note, /список полей ManyChat не прочитался/, 'причина названа');

// Одна тема упала — остальные записаны (правило «сбой одной не роняет остальные»).
let attempts = 0;
const s4 = syncStand({
  ...okRoutes,
  [PATHS.setBotFieldByName]: () => (++attempts === 2 ? { ok: false, status: 500, text: async () => 'oops' } : jsonOk({})),
});
const partialSync = await syncFunnelFields({ db: s4.db, config: s4.cfg, clientFactory: s4.clientFactory });
assert.equal(partialSync.results.filter((r) => r.status === 'set').length, 2, 'две темы записаны');
assert.equal(partialSync.results.filter((r) => r.status === 'failed').length, 1, 'одна отмечена сбоем');
assert.match(renderSyncReport(partialSync), /Записано полей: 2 из 3/, 'отчёт про это говорит');

// Тема без ссылки пропускается: пустое значение сломало бы уже работающий флоу.
const s5 = syncStand();
s5.db.funnel.upsert({ key: 'sales-posts', title: 'Продающий пост', file: '/tmp/x.pdf', url: null, pages: 5 });
const skipped = await syncFunnelFields({ db: s5.db, config: s5.cfg, clientFactory: s5.clientFactory });
const sales = skipped.results.find((r) => r.key === 'sales-posts');
assert.equal(sales.status, 'skipped', 'тема без ссылки пропущена');
assert.equal(s5.impl.calls.filter((c) => c.path === PATHS.setBotFieldByName).length, 2, 'пустое значение не отправлено');
assert.match(renderSyncReport(skipped), /пропущена/, 'и это видно в отчёте');

// Сухой прогон: ни одного запроса наружу и ни одной записи в БД.
const s6 = syncStand(okRoutes, { dryRun: true });
const dry = await syncFunnelFields({ db: s6.db, config: s6.cfg, clientFactory: s6.clientFactory });
assert.equal(s6.impl.calls.length, 0, 'в ManyChat ничего не ушло');
assert.equal(s6.db.funnel.getByKey('content-plan').manychat_at, null, 'и в БД отметки нет');
assert.match(renderSyncReport(dry), /Сухой прогон/, 'отчёт помечен как репетиция');

// Токена нет — честный отказ с подсказкой ручного пути, без единого запроса.
const s7 = syncStand(okRoutes, { token: null });
const noToken = await syncFunnelFields({ db: s7.db, config: s7.cfg, clientFactory: s7.clientFactory });
assert.equal(noToken.ok, false, 'без ключа синхронизации нет');
assert.match(noToken.error, /MANYCHAT_TOKEN/, 'сказано, чего не хватает');
assert.match(noToken.error, /воронка настройка/, 'и предложен ручной путь');
assert.equal(s7.impl.calls.length, 0, 'запросов не было');

// Одна тема по ключу — трогаем только её.
const s8 = syncStand();
const oneKey = await syncFunnelFields({ db: s8.db, config: s8.cfg, key: 'reels', clientFactory: s8.clientFactory });
assert.equal(oneKey.results.length, 1, 'синхронизирована одна тема');
assert.equal(oneKey.results[0].field, 'pdf_reels_hooks', 'нашлась по ключевому слову');
const missKey = await syncFunnelFields({ db: s8.db, config: s8.cfg, key: 'нет', clientFactory: s8.clientFactory });
assert.match(missKey.error, /нет в manychat\/funnel\.json/, 'чужой ключ — понятный отказ');

// ── Расхождение статики и ManyChat ────────────────────────────────────────
// Клиент сменил PUBLIC_BASE_URL и пересобрал PDF: в поле ManyChat остался старый адрес.
const s9 = syncStand();
s9.db.funnel.markSynced({ key: 'content-plan', field: 'pdf_content_plan', url: 'https://old.example.com/a.pdf' });
const drift = funnelView({ topics, rows: s9.db.funnel.list(), settings });
assert.match(drift[0].warns.join(' '), /в ManyChat записана другая ссылка/, 'расхождение замечено');
assert.match(renderFunnelState(drift, { hasToken: true }), /воронка синх/, 'и сказано, чем чинить');
assert.equal(drift[1].warns.length, 0, 'у синхронной темы претензий нет');

for (const s of [s1, s2, s3, s4, s5, s6, s7, s8, s9]) s.db.close();
await fsp.rm(path.dirname(funnelFile), { recursive: true, force: true });

console.log('✅ smoke-manychat: ключи, поля, тексты, карточка настройки и синхронизация — ок');
