// Оффлайн-проверка предполётной диагностики публикации (IG + Threads).
//
// Живьём её можно прогнать только на аккаунтах клиента, поэтому здесь подделываются и Meta, и
// файловая система, и публичная статика. Проверяем не «код выполнился», а то, ради чего модуль
// написан: каждая типовая ошибка настройки названа своим именем и не пропущена как «всё ок».
//
// Запуск: node scripts/smoke-preflight.mjs

import assert from 'node:assert/strict';
import { parsePreflightCommand, preflight, renderPreflight } from '../src/publish/preflight.js';

/** Конфиг «всё настроено правильно». Каждый тест портит в нём ровно одну вещь. */
const goodConfig = {
  metaGraphVersion: 'v21.0',
  igGraphBaseUrl: 'https://graph.facebook.com',
  igUserId: '17841400000000001',
  igAccessToken: 'IG-TOKEN',
  threadsGraphBaseUrl: 'https://graph.threads.net',
  threadsUserId: '9480000000002',
  threadsAccessToken: 'THREADS-TOKEN',
  publicDir: '/var/www/content-pipeline',
  publicBaseUrl: 'https://media.example.com',
  metaAppId: null,
  metaAppSecret: null,
};

/** Файловая система в памяти: проверка обязана писать временный файл и убирать за собой. */
function fakeFs({ failWrite = false } = {}) {
  const files = new Map();
  return {
    files,
    mkdirSync() {},
    writeFileSync(p, data) {
      if (failWrite) throw new Error('EACCES: permission denied');
      files.set(p, data);
    },
    rmSync(p) {
      files.delete(p);
    },
  };
}

/**
 * Поддельная Meta + поддельная статика.
 * @param {object} o.graph  путь эндпоинта → ответ или Error
 * @param {object} o.staticRes  что отдаёт публичная ссылка
 */
function fakeFetch({ graph = {}, staticRes = null, store = null } = {}) {
  const calls = [];
  return async (url) => {
    const u = String(url);
    calls.push(u);

    // Публичная статика: отдаём ровно то, что «записали» в файловую систему.
    if (u.startsWith('https://media.example.com') || u.startsWith('http://media.example.com')) {
      if (staticRes instanceof Error) throw staticRes;
      if (staticRes) return staticRes;
      const body = store ? [...store.files.values()][0] : '';
      return { ok: true, status: 200, async text() { return body ?? ''; } };
    }

    for (const [needle, res] of Object.entries(graph)) {
      if (!u.includes(needle)) continue;
      if (res instanceof Error) throw res;
      return { ok: true, status: 200, async json() { return res; } };
    }
    // Ничего не подменили — считаем, что Meta ответила ошибкой прав.
    return {
      ok: false,
      status: 400,
      async json() {
        return { error: { message: 'Unsupported request', code: 100 } };
      },
    };
  };
}

/** Ответы Meta для полностью исправной настройки. */
const goodGraph = {
  '/17841400000000001?': { id: '17841400000000001', username: 'client_studio', media_count: 214 },
  'content_publishing_limit': { data: [{ quota_usage: 3, config: { quota_total: 50 } }] },
  'graph.threads.net/v21.0/me': { id: '9480000000002', username: 'client_studio' },
  'threads_publishing_limit': { data: [{ quota_usage: 1, config: { quota_total: 250 } }] },
};

/** Ищет проверку по имени. */
const find = (res, name) => res.checks.find((c) => c.name === name);
/** Все провалившиеся проверки одной области. */
const fails = (res, area) => res.checks.filter((c) => c.area === area && c.status === 'fail');

// ── 1. Всё настроено правильно ───────────────────────────────────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: goodConfig,
    fetchImpl: fakeFetch({ graph: goodGraph, store }),
    fsImpl: store,
  });

  assert.equal(res.ig, true, 'исправная настройка → Instagram готов');
  assert.equal(res.threads, true, 'исправная настройка → Threads готов');
  assert.equal(fails(res, 'static').length, 0, 'статика без замечаний');
  assert.match(find(res, 'Аккаунт Instagram').detail, /@client_studio/, 'видно, в чей аккаунт полетят посты');
  assert.match(find(res, 'Аккаунт Threads').detail, /@client_studio/, 'аккаунт Threads тоже назван');
  assert.equal(store.files.size, 0, 'временный файл проверки удалён');

  const text = renderPreflight(res);
  assert.match(text, /Instagram: можно публиковать/, 'вердикт по Instagram в отчёте');
  assert.match(text, /Ничего не опубликовано/, 'сказано, что проверка безопасна');
}

// ── 2. Статика не видна снаружи: карусель и Reels невозможны ─────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: goodConfig,
    fetchImpl: fakeFetch({
      graph: goodGraph,
      store,
      staticRes: { ok: false, status: 404, async text() { return ''; } },
    }),
    fsImpl: store,
  });

  assert.equal(res.ig, false, 'без публичной статики Instagram публиковать нельзя');
  assert.equal(res.threads, true, 'а текстовому Threads статика не нужна');
  assert.match(find(res, 'Файл виден снаружи').detail, /404/, 'код ответа назван');
  assert.match(find(res, 'Файл виден снаружи').hint, /Nginx/, 'подсказано, где искать причину');
}

// ── 3. Статика отдаёт чужой файл (заглушка сайта на том же домене) ───────
{
  const store = fakeFs();
  const res = await preflight({
    config: goodConfig,
    fetchImpl: fakeFetch({
      graph: goodGraph,
      store,
      staticRes: { ok: true, status: 200, async text() { return '<html>сайт</html>'; } },
    }),
    fsImpl: store,
  });

  assert.equal(res.ig, false, '200 с чужим содержимым — это не рабочая статика');
  assert.match(find(res, 'Файл виден снаружи').detail, /содержимое чужое/, 'подмена названа прямо');
}

// ── 4. PUBLIC_BASE_URL по http: Meta такое медиа не заберёт ──────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: { ...goodConfig, publicBaseUrl: 'http://media.example.com' },
    fetchImpl: fakeFetch({ graph: goodGraph, store }),
    fsImpl: store,
  });

  assert.equal(res.ig, false, 'http вместо https блокирует Instagram');
  assert.match(find(res, 'Протокол').detail, /не https/, 'причина названа');
}

// ── 5. Нет прав на запись в PUBLIC_DIR ───────────────────────────────────
{
  const store = fakeFs({ failWrite: true });
  const res = await preflight({ config: goodConfig, fetchImpl: fakeFetch({ graph: goodGraph }), fsImpl: store });

  assert.equal(res.ig, false, 'без записи в публичную папку публиковать нечем');
  assert.match(find(res, 'Запись в PUBLIC_DIR').hint, /chown/, 'подсказана команда починки');
}

// ── 6. Токен Instagram протух ────────────────────────────────────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: goodConfig,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('media.example.com')) {
        return { ok: true, status: 200, async text() { return [...store.files.values()][0] ?? ''; } };
      }
      if (u.includes('graph.facebook.com')) {
        return {
          ok: false,
          status: 400,
          async json() {
            return { error: { message: 'Error validating access token', code: 190 } };
          },
        };
      }
      return { ok: true, status: 200, async json() { return goodGraph['graph.threads.net/v21.0/me']; } };
    },
    fsImpl: store,
  });

  assert.equal(res.ig, false, 'протухший токен → публиковать нельзя');
  // Код 190 объясняется словами общим транспортом graph.js — проверка не должна это терять.
  assert.match(find(res, 'Аккаунт Instagram').detail, /истёк|недействителен/, 'ошибка переведена на человеческий');
}

// ── 7. Токен рабочий, но права на публикацию нет ─────────────────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: goodConfig,
    fetchImpl: fakeFetch({
      graph: {
        '/17841400000000001?': goodGraph['/17841400000000001?'],
        'graph.threads.net/v21.0/me': goodGraph['graph.threads.net/v21.0/me'],
        'threads_publishing_limit': goodGraph.threads_publishing_limit,
        // content_publishing_limit НЕ подменён → вернётся ошибка прав
      },
      store,
    }),
    fsImpl: store,
  });

  assert.equal(res.ig, false, 'без права публикации Instagram не готов');
  assert.match(find(res, 'Право на публикацию').hint, /dev-mode|тестер/, 'подсказано про dev-mode');
}

// ── 8. В Threads вставлены креды Instagram — самая частая ошибка ─────────
{
  const store = fakeFs();
  const res = await preflight({
    config: { ...goodConfig, threadsAccessToken: 'IG-TOKEN', threadsUserId: '17841400000000001' },
    fetchImpl: fakeFetch({ graph: goodGraph, store }),
    fsImpl: store,
  });

  assert.equal(res.threads, false, 'скопированные креды Instagram → Threads не готов');
  const detected = res.checks.filter((c) => c.status === 'fail').map((c) => c.name);
  assert.ok(detected.includes('Токены площадок'), 'совпадение токенов поймано');
  assert.ok(detected.includes('Id площадок'), 'совпадение id поймано');
  assert.equal(res.ig, true, 'на Instagram чужая ошибка Threads не влияет');
}

// ── 9. THREADS_USER_ID не тот, что у токена ──────────────────────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: { ...goodConfig, threadsUserId: '9999999999999' },
    fetchImpl: fakeFetch({ graph: goodGraph, store }),
    fsImpl: store,
  });

  assert.equal(res.threads, false, 'чужой id ловится до публикации');
  assert.match(find(res, 'Аккаунт Threads').detail, /9480000000002/, 'показан настоящий id из API');
}

// ── 10. Пустой .env: проверка объясняет, чего не хватает ─────────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: { ...goodConfig, igUserId: null, igAccessToken: null, threadsUserId: null, threadsAccessToken: null, publicDir: null, publicBaseUrl: null },
    fetchImpl: fakeFetch({}),
    fsImpl: store,
  });

  assert.equal(res.ig, false, 'без кредов публиковать нельзя');
  assert.equal(res.threads, false, 'и в Threads тоже');
  const text = renderPreflight(res);
  assert.match(text, /IG_USER_ID/, 'названа недостающая переменная Instagram');
  assert.match(text, /THREADS_USER_ID/, 'названа недостающая переменная Threads');
  assert.match(text, /PUBLIC_DIR/, 'названа недостающая публичная статика');
}

// ── 11. Срок жизни токена: проверка включается только с META_APP_* ───────
{
  const store = fakeFs();
  const soon = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const res = await preflight({
    config: { ...goodConfig, metaAppId: '111', metaAppSecret: 'secret' },
    fetchImpl: fakeFetch({
      graph: {
        ...goodGraph,
        'debug_token': { data: { is_valid: true, expires_at: soon, scopes: ['instagram_basic', 'instagram_content_publish'] } },
      },
      store,
    }),
    fsImpl: store,
  });

  const life = find(res, 'Срок жизни токена');
  assert.equal(life.status, 'warn', 'скорое истечение — предупреждение');
  assert.match(life.detail, /5 дн\./, 'посчитан остаток дней');
  assert.equal(res.ig, true, 'предупреждение не блокирует публикацию');
}

// ── 12. У токена нет нужного права — это уже блокирует ───────────────────
{
  const store = fakeFs();
  const res = await preflight({
    config: { ...goodConfig, metaAppId: '111', metaAppSecret: 'secret' },
    fetchImpl: fakeFetch({
      graph: { ...goodGraph, 'debug_token': { data: { is_valid: true, expires_at: 0, scopes: ['instagram_basic'] } } },
      store,
    }),
    fsImpl: store,
  });

  assert.equal(res.ig, false, 'без instagram_content_publish публиковать нельзя');
  assert.match(find(res, 'Права токена').detail, /instagram_content_publish/, 'названо недостающее право');
}

// ── 13. Команда: со слешем и словами ─────────────────────────────────────
{
  for (const t of [
    '/проверка',
    '/проверка@PublisherBot',
    '/check',
    'проверка',
    'Проверка',
    'проверь настройки',
    'проверь публикацию',
    'проверь токены',
    'проверка публикации!',
  ]) {
    assert.deepEqual(parsePreflightCommand(t), { ok: true }, `команда: «${t}»`);
  }

  // Задача Издателю командой не считается — иначе вместо работы агента приходил бы отчёт.
  for (const t of [
    'проверь пост перед публикацией',
    'проверь, всё ли в тексте на месте',
    'проверка орфографии в посте',
    'опубликуй #12',
  ]) {
    assert.equal(parsePreflightCommand(t), null, `не команда: «${t}»`);
  }
}

console.log('✓ smoke-preflight PASS — статика, токены, права и перекрёстные ошибки настройки ловятся');
