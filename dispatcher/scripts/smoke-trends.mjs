// Смоук-тест сбора трендов (T09): конфиг источников, клиент Apify, нормализация, дедуп,
// разбор Разведчиком, суточный лимит и автозапуск.
//
// ОФФЛАЙН И БЕСПЛАТНО: ни одного реального запроса в Apify (fetch подменён) и ни одного вызова
// claude -p (агент подменён). Проверяется механика, а не удача сети.
// Запуск: node dispatcher/scripts/smoke-trends.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.js';
import { ApifyError, actorPath, explainStatus, runActor } from '../src/trends/apify.js';
import {
  buildActorInput,
  buildTargets,
  enabledPlatforms,
  limitsOf,
  loadSources,
  validateSources,
} from '../src/trends/sources.js';
import { buildDigest, normalizeItems, parseTopicsFromMeta, toCount, toDate, topPosts } from '../src/trends/normalize.js';
import { apifyProvider, getProvider, loginProvider } from '../src/trends/providers.js';
import { hhmm, parseTrendsCommand, runTrends, startTrendsScheduler, todayStamp } from '../src/trends/run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'trends-sources.json');
const EXAMPLE = path.join(__dirname, '..', '..', 'trends', 'sources.example.json');

// ── Конфиг источников ─────────────────────────────────────────────────────
const missing = loadSources(path.join(__dirname, 'нет-такого.json'));
assert.equal(missing.ok, false, 'отсутствующий файл источников — не крэш, а внятный отказ');
assert.match(missing.error, /sources\.example\.json/, 'сказано, что копировать');

const shipped = loadSources(EXAMPLE);
assert.equal(shipped.ok, true, 'trends/sources.example.json обязан быть рабочим конфигом');

const loaded = loadSources(FIXTURE);
assert.equal(loaded.ok, true, `фикстура источников читается: ${loaded.error || ''}`);
const sources = loaded.sources;

assert.deepEqual(limitsOf(sources), { runsPerDay: 1, postsPerSource: 5, maxPostsPerRun: 10 }, 'лимиты из файла');
assert.deepEqual(enabledPlatforms(sources).map((p) => p.platform), ['ig', 'threads'], 'включены обе площадки');

assert.match(
  validateSources({ platforms: { ig: { enabled: true, accounts: ['x'] } } }).error,
  /не задан actor/,
  'включённая площадка без актора — ошибка ДО траты денег',
);
assert.match(validateSources({ platforms: { vk: {} } }).error, /неизвестные площадки/, 'опечатка в площадке видна');
assert.match(validateSources({ platforms: { ig: { enabled: false } } }).error, /ни одна площадка/, 'собирать нечего');
assert.match(
  validateSources({ platforms: { ig: { enabled: true, actor: 'a/b' } } }).error,
  /accounts\/hashtags/,
  'актор без целей — тоже ошибка',
);

// Цели → ссылки; кириллический хэштег кодируется.
const igTargets = buildTargets(sources.platforms.ig, 'ig');
assert.equal(igTargets[0].url, 'https://www.instagram.com/nike/', 'аккаунт → ссылка на профиль');
assert.match(igTargets[1].url, /explore\/tags\/%D0%BC/, 'хэштег → ссылка на тег, кириллица закодирована');

// Вход актора собирается по именам полей ИЗ КОНФИГА — в этом весь смысл слоя.
const igInput = buildActorInput(sources.platforms.ig, igTargets, { postsPerSource: 5 });
assert.deepEqual(Object.keys(igInput).sort(), ['directUrls', 'resultsLimit', 'resultsType'], 'поля входа из конфига');
assert.equal(igInput.directUrls.length, 2, 'обе цели ушли в актор');
assert.equal(igInput.resultsLimit, 5, 'лимит на источник проставлен');
assert.ok(!('_' in igInput), 'ключи-подсказки в актор не уходят');

const thInput = buildActorInput(sources.platforms.threads, buildTargets(sources.platforms.threads, 'threads'), {
  postsPerSource: 5,
});
assert.deepEqual(Object.keys(thInput).sort(), ['maxItems', 'urls'], 'у другого актора — другие имена полей');

// ── Клиент Apify ──────────────────────────────────────────────────────────
assert.equal(actorPath('apify/instagram-scraper'), 'apify~instagram-scraper', 'слэш в id актора → тильда');
assert.match(explainStatus(401), /APIFY_TOKEN/, '401 объясняется токеном');
assert.match(explainStatus(404), /актор не найден/, '404 объясняется актором');
assert.match(explainStatus(402), /кредиты/, '402 объясняется кредитами');

await assert.rejects(
  () => runActor({ token: '', actorId: 'a/b', fetchImpl: async () => {} }),
  /APIFY_TOKEN/,
  'без токена в сеть не ходим',
);

await assert.rejects(
  () =>
    runActor({
      token: 't',
      actorId: 'a/b',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
    }),
  (err) => err instanceof ApifyError && /APIFY_TOKEN/.test(err.message),
  'ошибка Apify приходит человеческой причиной, а не стектрейсом',
);

// Зависший прогон останавливаем сами — иначе он молча доедает кредиты клиента.
let aborted = false;
await assert.rejects(
  () =>
    runActor({
      token: 't',
      actorId: 'a/b',
      timeoutMs: 40,
      pollMs: 5,
      fetchImpl: async (url, opts = {}) => {
        if (String(url).includes('/abort')) {
          aborted = true;
          return { ok: true, json: async () => ({}) };
        }
        if (opts.method === 'POST') {
          return { ok: true, json: async () => ({ data: { id: 'r1', defaultDatasetId: 'd1', status: 'RUNNING' } }) };
        }
        return { ok: true, json: async () => ({ data: { status: 'RUNNING' } }) };
      },
    }),
  /не уложился/,
  'дедлайн прогона соблюдается',
);
assert.ok(aborted, 'зависший прогон Apify остановлен (ABORT)');

// ── Нормализация выдачи актора ────────────────────────────────────────────
assert.equal(toCount([{}, {}, {}]), 3, 'массив комментариев → его длина');
assert.equal(toCount('12'), 12, 'число строкой → число');
assert.equal(toCount(null), null, 'нет значения → null, а не 0');
assert.equal(toDate(1757200000), '2025-09-06', 'unix-секунды → дата');
assert.equal(toDate('2026-09-05T10:00:00.000Z'), '2026-09-05', 'ISO → дата');
assert.equal(toDate('позавчера'), null, 'мусор в дате не притворяется датой');

const igItems = [
  {
    url: 'https://www.instagram.com/p/aaa/',
    ownerUsername: 'nike',
    caption: 'Как мы запускали кроссовки: 3 ошибки',
    likesCount: 120,
    comments: [{}, {}, {}],
    timestamp: 1757200000,
    inputUrl: 'https://www.instagram.com/nike/',
  },
  {
    url: 'https://www.instagram.com/p/bbb/',
    ownerUsername: 'agency',
    caption: 'Пост про маркетинг без бюджета',
    likesCount: 20,
    commentsCount: 4,
    timestamp: '2026-09-05T10:00:00.000Z',
    inputUrl: igTargets[1].url,
  },
  { url: 'https://www.instagram.com/p/aaa/', ownerUsername: 'nike', caption: 'дубль в той же выдаче' },
  { somethingElse: true },
];

const igPosts = normalizeItems(igItems, { platform: 'ig', map: {} });
assert.equal(igPosts.length, 2, 'дубль и мусор отброшены');
assert.equal(igPosts[0].likes, 120, 'лайки распознаны');
assert.equal(igPosts[0].comments, 3, 'комментарии-массив посчитаны длиной');
assert.match(igPosts[0].postedAt, /^\d{4}-\d{2}-\d{2}$/, 'дата приведена к YYYY-MM-DD');

// Актор с чужими именами полей читается через map из конфига — код не меняется.
const thPosts = normalizeItems(
  [
    {
      url: 'https://www.threads.net/@zuck/post/1',
      user: { handle: 'zuck' },
      postText: 'Тред про нейросети в контенте',
      stats: { likes: 44 },
      publishedAt: '2026-09-06T08:00:00Z',
    },
  ],
  { platform: 'threads', map: sources.platforms.threads.map },
);
assert.equal(thPosts[0].author, 'zuck', 'автор взят по map (user.handle)');
assert.equal(thPosts[0].text, 'Тред про нейросети в контенте', 'текст взят по map (postText)');
assert.equal(thPosts[0].likes, 44, 'лайки взяты по map (stats.likes)');

assert.equal(topPosts([...igPosts, ...thPosts], 2).length, 2, 'потолок прогона режет выборку');
assert.equal(topPosts([...igPosts, ...thPosts], 2)[0].likes, 120, 'оставляем самые заметные');

const digest = buildDigest(igPosts);
assert.match(digest, /@nike/, 'в материале для Разведчика виден автор');
assert.match(digest, /♥ 120/, 'и метрики');
assert.match(digest, /instagram\.com\/p\/aaa/, 'и ссылка на пост');
assert.equal(buildDigest([{ platform: 'ig', text: 'a'.repeat(500), url: null }], { textLimit: 100 }).includes('…'), true, 'длинные тексты режутся');

assert.deepEqual(
  parseTopicsFromMeta({ topics: [{ topic: 'Тема', why: 'w', angle: 'a' }, { topic: '' }] }),
  [{ topic: 'Тема', why: 'w', angle: 'a' }],
  'пустые темы отбрасываются',
);

// ── Фейковый Apify: провайдер целиком ─────────────────────────────────────
let wave = 1; // вторая «волна» отдаёт другие посты — на ней проверяется дедуп
const captured = { inputs: [] };
const fakeFetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => '' });

  if (opts.method === 'POST' && u.includes('/runs')) {
    captured.inputs.push(JSON.parse(opts.body));
    const ig = u.includes('apify~instagram-scraper');
    return json({ data: { id: ig ? 'run-ig' : 'run-th', defaultDatasetId: ig ? 'ds-ig' : 'ds-th', status: 'RUNNING' } });
  }
  if (u.includes('/actor-runs/')) return json({ data: { status: 'SUCCEEDED' } });
  if (u.includes('/datasets/ds-ig/items')) {
    return json(wave === 1 ? igItems : [{ ...igItems[0], url: 'https://www.instagram.com/p/ccc/', caption: 'новый пост' }]);
  }
  if (u.includes('/datasets/ds-th/items')) {
    return json(
      wave === 1
        ? [
            {
              url: 'https://www.threads.net/@zuck/post/1',
              user: { handle: 'zuck' },
              postText: 'Тред про нейросети в контенте',
              stats: { likes: 44 },
              publishedAt: '2026-09-06T08:00:00Z',
              inputUrl: 'https://www.threads.net/@zuck',
            },
          ]
        : [],
    );
  }
  throw new Error(`неожиданный запрос: ${u}`);
};

const config = {
  apifyToken: 'test-token',
  apifyBaseUrl: 'https://api.apify.com/v2',
  apifyTimeoutMs: 2_000,
  apifyPollMs: 5,
  apifyActors: {},
  trendsProvider: 'apify',
  trendsSourcesPath: FIXTURE,
  trendsAt: null,
};

const collected = await apifyProvider.collect({ sources, config, fetchImpl: fakeFetch });
assert.equal(collected.posts.length, 3, 'собраны обе площадки (2 IG + 1 Threads)');
assert.equal(collected.posts.find((p) => p.url.includes('/p/aaa')).sourceQuery, '@nike', 'источник поста определён');
assert.equal(collected.posts.find((p) => p.url.includes('/p/bbb')).sourceQuery, '#маркетинг', 'хэштег-источник тоже');
assert.equal(captured.inputs.length, 2, 'запущено два актора — по одному на площадку');
assert.ok(captured.inputs[0].directUrls && captured.inputs[1].urls, 'каждому актору ушёл СВОЙ формат входа');

assert.equal(
  apifyProvider.available({ config: { apifyToken: null } }).ok,
  false,
  'без токена провайдер честно не готов',
);
assert.match(apifyProvider.available({ config: { apifyToken: null } }).error, /APIFY_TOKEN/, 'сказано, чего не хватает');

// Резервный вариант C: заявлен, но не реализован — и говорит об этом прямо.
assert.equal(loginProvider.available().ok, false, 'вариант C не притворяется рабочим');
assert.match(loginProvider.available().error, /прокси/, 'названы обязательные страховки');
await assert.rejects(() => loginProvider.collect(), /НЕ реализован/i, 'резерв не делает вид, что собирает');
assert.equal(getProvider('apify').name, 'apify', 'провайдер по имени');
assert.throws(() => getProvider('шмапифай'), /неизвестный TRENDS_PROVIDER/, 'опечатка в .env видна сразу');

// ── Полный прогон: сбор → дедуп → Разведчик → темы ────────────────────────
const db = openDb(':memory:');
assert.ok(db.appliedMigrations.includes('005_trends'), 'миграция 005_trends должна примениться');

const scoutTasks = [];
const scoutOk = async ({ agentKey, task }) => {
  scoutTasks.push({ agentKey, task });
  return {
    ok: true,
    content: [
      'Разобрано 3 поста, 2 темы.',
      '',
      '=== ТЕМА 1: Ошибки запуска ===',
      'Почему заходит: аудитория узнаёт себя',
      'Угол: 3 ошибки, которые стоили нам месяца',
      '',
      '=== ТЕМА 2: Нейросети в контенте ===',
      'Почему заходит: тема на слуху',
      'Угол: что реально отдаём нейросети, а что нет',
    ].join('\n'),
    meta: {
      kind: 'trend_report',
      status: 'draft',
      title: 'Разбор сбора',
      topics: [
        { topic: 'Ошибки запуска', why: 'аудитория узнаёт себя', angle: '3 ошибки' },
        { topic: 'Нейросети в контенте', why: 'на слуху', angle: 'что отдаём нейросети' },
      ],
    },
  };
};

const run1 = await runTrends({ db, config, provider: apifyProvider, agentRunner: scoutOk, fetchImpl: fakeFetch });
assert.equal(run1.status, 'ok', `прогон должен пройти: ${run1.error || ''}`);
assert.equal(run1.found, 3, 'найдено 3 поста');
assert.equal(run1.added, 3, 'все три новые');
assert.equal(run1.topics, 2, 'две темы');
assert.match(run1.report, /ТЕМА 1/, 'отчёт Разведчика в формате контракта');
assert.match(run1.report, /собрано 3, новых 3/, 'в шапке отчёта видно, откуда материал');
assert.equal(db.trends.listTopics().length, 2, 'темы сохранены в БД');
assert.equal(db.trends.getRun(run1.runId).status, 'ok', 'прогон закрыт статусом ok');
assert.equal(db.trends.countPosts(), 3, 'посты сохранены — это база дедупа');

const task = scoutTasks[0].task;
assert.equal(scoutTasks[0].agentKey, 'scout', 'разбирает именно Разведчик');
assert.match(task, /МАТЕРИАЛ:/, 'агенту ушёл материал');
assert.match(task, /@nike/, 'с авторами');
assert.match(task, /Источники:/, 'и с перечнем источников');

// Суточный лимит: второй прогон в тот же день не запускается.
const run2 = await runTrends({ db, config, provider: apifyProvider, agentRunner: scoutOk, fetchImpl: fakeFetch });
assert.equal(run2.status, 'skipped', 'лимит «1 прогон/день» работает');
assert.match(run2.error, /лимит суток/, 'причина названа');
assert.equal(db.trends.countPosts(), 3, 'при отказе по лимиту ничего не собиралось');

// Осознанный обход лимита («/тренды сейчас») — но те же посты второй раз Разведчику не уходят.
const before = scoutTasks.length;
const run3 = await runTrends({ db, config, provider: apifyProvider, agentRunner: scoutOk, fetchImpl: fakeFetch, force: true });
assert.equal(run3.status, 'empty', 'дедуп: нового нет — разбирать нечего');
assert.equal(scoutTasks.length, before, 'вызов claude -p не потрачен впустую');
assert.equal(db.trends.getRun(run3.runId).status, 'empty', 'прогон записан как пустой');

// Разведчик упал: материал НЕ теряется (за него уже заплачено Apify), прогон помечен failed.
wave = 2;
const run4 = await runTrends({
  db,
  config,
  provider: apifyProvider,
  agentRunner: async () => ({ ok: false, error: 'claude -p не стартовал' }),
  fetchImpl: fakeFetch,
  force: true,
});
assert.equal(run4.status, 'failed', 'сбой агента виден статусом');
assert.match(run4.summary, /не ответил/, 'причина в сводке');
assert.equal(db.trends.countPosts(), 4, 'собранный пост сохранён, повторно за него не платим');
assert.equal(db.trends.getRun(run4.runId).status, 'failed', 'прогон закрыт как failed');

// Источники не настроены → ничего не тратим и честно говорим об этом.
const noSources = await runTrends({
  db,
  config: { ...config, trendsSourcesPath: path.join(__dirname, 'нет.json') },
  provider: apifyProvider,
  agentRunner: scoutOk,
  fetchImpl: fakeFetch,
  force: true,
});
assert.equal(noSources.status, 'skipped', 'без sources.json прогона нет');
assert.match(noSources.summary, /sources\.json/, 'сказано, чего не хватает');

// ── Команда и автозапуск ──────────────────────────────────────────────────
assert.deepEqual(parseTrendsCommand('/тренды'), { force: false, plain: false }, 'команда распознаётся');
assert.deepEqual(parseTrendsCommand('/тренды сейчас'), { force: true, plain: false }, 'обход лимита распознаётся');
assert.deepEqual(parseTrendsCommand('/trends now'), { force: true, plain: false }, 'латиница тоже');
assert.deepEqual(parseTrendsCommand('/тренды@scout_bot'), { force: false, plain: false }, 'форма с @именем бота');

// Команда СЛОВАМИ, без слеша. Прогон актора платный, поэтому фраза распознаётся целиком:
// приказ — это глагол + «тренды» + возможное слово обхода лимита, и ничего сверх того.
for (const t of ['тренды', 'Тренды', 'тренды!', 'собери тренды', 'собрать тренды', 'обнови тренды', 'покажи тренды', 'trends']) {
  assert.deepEqual(parseTrendsCommand(t), { force: false, plain: true }, `словами: «${t}»`);
}
for (const t of ['тренды сейчас', 'собери тренды сейчас', 'запусти тренды заново']) {
  assert.deepEqual(parseTrendsCommand(t), { force: true, plain: true }, `словами с обходом лимита: «${t}»`);
}
// Живая речь командой НЕ считается — иначе разговор о трендах сжигал бы платный прогон.
for (const t of [
  'расскажи про тренды',
  'какие тренды сейчас заходят в нише',
  'тренды в маникюре — что важно',
  'напиши пост про тренды',
  'собери тренды и сделай пост',
  'проанализируй тренды конкурентов',
]) {
  assert.equal(parseTrendsCommand(t), null, `не команда: «${t}»`);
}
assert.match(todayStamp(new Date('2026-09-07T12:00:00')), /^2026-09-07$/, 'дата прогона — локальная');
assert.match(hhmm(new Date('2026-09-07T09:05:00')), /^09:05$/, 'время автозапуска — локальное');

const db2 = openDb(':memory:');
wave = 1;
const stop = startTrendsScheduler({
  db: db2,
  config: { ...config, trendsAt: '00:00' },
  intervalMs: 20,
  provider: apifyProvider,
  agentRunner: scoutOk,
  fetchImpl: fakeFetch,
});
await new Promise((r) => setTimeout(r, 150));
stop();
assert.equal(db2.trends.countRunsOnDay(todayStamp()), 1, 'автозапуск сделал ровно один прогон за сутки');
assert.equal(db2.trends.listTopics().length, 2, 'темы автозапуска сохранены');

db.close();
db2.close();
console.log('✓ smoke-trends PASS — Apify-сбор, дедуп, суточный лимит и разбор Разведчиком на месте');
