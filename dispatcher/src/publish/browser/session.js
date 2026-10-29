// Вход в Instagram и Threads живым браузером и хранение сессии (вариант C, включён решением
// владельца 15.09.2026 — см. правило 4 в CLAUDE.md).
//
// ЗАЧЕМ ЭТО ЕСТЬ. Основной путь публикации — Meta Graph API (src/publish/instagram.js). Здесь
// альтернатива: диспетчер заходит в аккаунт клиента как человек и публикует через веб-интерфейс.
// Путь через API остаётся рядом рабочим и переключается одной переменной IG_MODE — если браузер
// упрётся в проверку, публикация возвращается на API без правки кода.
//
// ── Три вещи, которые определяют всю конструкцию ────────────────────────────────────────────
//
// 1. ВХОД ОДИН, СЕССИЯ ПОСТОЯННАЯ. Логиниться перед каждым постом нельзя: серия входов — самый
//    заметный признак автоматизации, и аккаунт уедет в проверку. Поэтому браузер запускается
//    через launchPersistentContext с постоянной папкой профиля: куки, localStorage и «доверенное
//    устройство» переживают перезапуск диспетчера и перезагрузку VPS. Вход делается ОДИН раз
//    руками (`npm run ig:login`), дальше код только проверяет, что сессия ещё жива.
//
// 2. ПЕРВЫЙ ВХОД ПОТРЕБУЕТ ЧЕЛОВЕКА, И ЭТО НЕ БАГ. Вход с датацентрового IP Instagram почти
//    наверняка встретит проверкой: код на почту/телефон, а при включённой 2FA — код приложения.
//    Обойти проверку мы не пытаемся и средств для этого здесь нет: код спрашивается у владельца
//    (функция askCode) и вводится как есть. Владелец аккаунта подтверждает СВОЙ вход — это
//    ровно то, для чего проверка сделана.
//
// 3. ЯЗЫК ИНТЕРФЕЙСА ФОРСИРОВАН. Селекторы кнопок держатся на видимом тексте, а Instagram
//    переводит интерфейс по языку аккаунта. Клиент переключит язык на русский — и весь вход
//    сломается. Контекст всегда просит en-US, поэтому вёрстка предсказуема независимо от
//    настроек аккаунта.
//
// Threads отдельного пароля не имеет: вход идёт аккаунтом Instagram. Поэтому профиль браузера
// ОДИН на обе площадки, и после входа в Instagram Threads подхватывается кнопкой подтверждения.

import fs from 'node:fs';
import path from 'node:path';

import { findBrowser, NO_BROWSER_HINT } from '../../../../render/index.js';
import { IG, IG_ORIGIN, IG_CHALLENGE_URLS, SESSION_COOKIE, THREADS, THREADS_ORIGIN } from './selectors.js';

/** Сколько ждём реакции страницы на обычное действие. */
const STEP_TIMEOUT_MS = 20_000;

/** Сколько ждём результата отправки формы входа (там редиректы и проверки). */
const LOGIN_TIMEOUT_MS = 45_000;

/**
 * Открывает браузер с ПОСТОЯННЫМ профилем.
 *
 * @param {object} o
 * @param {string} o.profileDir     папка профиля (куки и сессия живут здесь)
 * @param {boolean} [o.headless]    на VPS всегда true; false — только для отладки с иксами
 * @param {string} [o.executablePath]
 * @returns {Promise<{context: object, close: Function}>}
 */
export async function openSession({ profileDir, headless = true, executablePath = null }) {
  if (!profileDir) throw new Error('не задан IG_PROFILE_DIR — папка профиля браузера');

  const bin = executablePath || findBrowser();
  if (!bin) throw new Error(NO_BROWSER_HINT);

  fs.mkdirSync(profileDir, { recursive: true });

  const { chromium } = await import('playwright-core');
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: bin,
    headless,
    // en-US форсирован намеренно: см. пункт 3 в шапке файла.
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  return { context, close: () => context.close().catch(() => {}) };
}

/**
 * Есть ли живая сессия на площадке. Проверяем КУКУ, а не страницу: это единственный признак,
 * который не зависит ни от языка, ни от редизайна, ни от того, докрутилась ли лента.
 * @returns {Promise<boolean>}
 */
export async function hasSession(context, origin) {
  const cookies = await context.cookies(origin);
  return cookies.some((c) => c.name === SESSION_COOKIE && c.value);
}

/** Состояние обеих площадок одним вызовом — это и есть ответ на «/вход» в топике. */
export async function sessionState(context) {
  return {
    instagram: await hasSession(context, IG_ORIGIN),
    threads: await hasSession(context, THREADS_ORIGIN),
  };
}

/**
 * Первый подходящий селектор из списка. Варианты перебираются по очереди, потому что Instagram
 * раскатывает изменения процентом аудитории: у клиента может быть вёрстка, которой у нас не было.
 * @returns {Promise<object|null>} locator или null
 */
async function firstVisible(page, selectors, timeout = 3_000) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch {
      // этого варианта нет — пробуем следующий
    }
  }
  return null;
}

/** Клик по первому найденному варианту. Возвращает true, если было по чему кликать. */
async function clickIfPresent(page, selectors, timeout = 3_000) {
  const loc = await firstVisible(page, selectors, timeout);
  if (!loc) return false;
  await loc.click().catch(() => {});
  return true;
}

/** Похоже ли, что вход упёрся в проверку. Смотрим на АДРЕС: формулировки переводятся, маршруты нет. */
export function isChallengeUrl(url) {
  return IG_CHALLENGE_URLS.some((frag) => String(url || '').includes(frag));
}

/**
 * Снимок экрана для владельца: без него «пришлите код» — это просьба вслепую.
 * По картинке видно, куда именно Instagram отправил код и не заблокирован ли аккаунт.
 * @returns {Promise<string|null>} путь к файлу
 */
async function shoot(page, shotsDir, name) {
  if (!shotsDir) return null;
  try {
    fs.mkdirSync(shotsDir, { recursive: true });
    const file = path.join(shotsDir, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/**
 * Вход в Instagram.
 *
 * @param {object} o
 * @param {object} o.context
 * @param {string} o.login
 * @param {string} o.password
 * @param {Function} [o.askCode]  async ({reason, screenshot}) => код|null. Без неё проверка = отказ
 * @param {string} [o.shotsDir]
 * @param {Function} [o.log]
 * @returns {Promise<{ok:boolean, reason?:string, screenshot?:string|null}>}
 */
export async function loginInstagram({ context, login, password, askCode = null, shotsDir = null, log = () => {} }) {
  if (!login || !password) return { ok: false, reason: 'не заданы IG_LOGIN и IG_PASSWORD в dispatcher/.env' };

  if (await hasSession(context, IG_ORIGIN)) {
    log('Instagram: сессия уже живая, вход не нужен');
    return { ok: true };
  }

  const page = await context.newPage();
  try {
    await page.goto(IG.loginUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });

    // Баннер cookie перекрывает форму оверлеем: пока он висит, клик по «Войти» уходит в пустоту.
    await clickIfPresent(page, IG.cookieBanner, 5_000);

    const userField = await firstVisible(page, IG.username, 10_000);
    if (!userField) {
      return {
        ok: false,
        reason: 'форма входа не найдена — Instagram изменил вёрстку либо показал заглушку',
        screenshot: await shoot(page, shotsDir, 'no-login-form'),
      };
    }

    await userField.fill(login);
    const passField = await firstVisible(page, IG.password, 5_000);
    if (!passField) return { ok: false, reason: 'поле пароля не найдено' };
    await passField.fill(password);

    await clickIfPresent(page, IG.submit, 5_000);

    // Ждём развилку: сессия / проверка / ошибка. Гонкой, а не по очереди — иначе на каждом
    // неудачном входе выжидали бы полный таймаут.
    const outcome = await waitForLoginOutcome(page, context);

    if (outcome === 'session') {
      await settleAfterLogin(page);
      log('Instagram: вход выполнен');
      return { ok: true };
    }

    if (outcome === 'error') {
      const alert = await firstVisible(page, IG.loginError, 2_000);
      const text = alert ? await alert.textContent().catch(() => '') : '';
      return {
        ok: false,
        reason: `Instagram отклонил вход${text ? `: ${text.trim()}` : ' — проверь логин и пароль'}`,
        screenshot: await shoot(page, shotsDir, 'login-error'),
      };
    }

    // Проверка. Дальше без человека хода нет — и не должно быть.
    return await passChallenge({ page, context, askCode, shotsDir, log });
  } catch (err) {
    return {
      ok: false,
      reason: `вход не дошёл до конца: ${err.message}`,
      screenshot: await shoot(page, shotsDir, 'login-crash'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Чем кончилась отправка формы: 'session' | 'challenge' | 'error' | 'timeout'.
 * Куку опрашиваем сами, потому что она ставится редиректом, а не событием страницы.
 */
async function waitForLoginOutcome(page, context, timeoutMs = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasSession(context, IG_ORIGIN)) return 'session';
    if (isChallengeUrl(page.url())) return 'challenge';

    const alert = await firstVisible(page, IG.loginError, 300);
    if (alert) return 'error';

    await page.waitForTimeout(700);
  }
  return 'timeout';
}

/**
 * Проверка Instagram: код на почту/телефон либо 2FA. Код спрашиваем у владельца и вводим как есть —
 * никакого обхода проверки здесь нет и не будет.
 */
async function passChallenge({ page, context, askCode, shotsDir, log }) {
  const screenshot = await shoot(page, shotsDir, 'challenge');

  if (!askCode) {
    return {
      ok: false,
      screenshot,
      reason: 'Instagram запросил подтверждение входа, а спросить код не у кого. Запусти вход руками: npm run ig:login',
    };
  }

  // Иногда сначала предлагают выбрать способ доставки и нажать «отправить код».
  await clickIfPresent(page, IG.codeSend, 3_000);

  const field = await firstVisible(page, IG.code, 10_000);
  if (!field) {
    return {
      ok: false,
      screenshot,
      reason: `Instagram показал проверку, но поля для кода нет (${page.url()}). Похоже на блокировку аккаунта — открой профиль руками`,
    };
  }

  log('Instagram: запрошено подтверждение входа, жду код от владельца');
  const code = await askCode({ reason: 'Instagram запросил код подтверждения входа', screenshot, url: page.url() });
  if (!code) return { ok: false, screenshot, reason: 'код подтверждения не получен — вход не завершён' };

  await field.fill(String(code).trim());
  if (!(await clickIfPresent(page, IG.codeSubmit, 5_000))) await field.press('Enter');

  const outcome = await waitForLoginOutcome(page, context, LOGIN_TIMEOUT_MS);
  if (outcome === 'session') {
    await settleAfterLogin(page);
    log('Instagram: вход подтверждён кодом');
    return { ok: true };
  }

  return {
    ok: false,
    screenshot: await shoot(page, shotsDir, 'challenge-failed'),
    reason: outcome === 'error' ? 'код не принят' : 'после ввода кода вход так и не завершился',
  };
}

/**
 * Диалоги сразу после входа. «Save info» жмём осознанно: он помечает устройство доверенным, и
 * следующий вход не потребует кода заново. «Not now» закрывает предложение уведомлений, иначе
 * модалка перекрывает интерфейс и следующий шаг кликает мимо.
 */
async function settleAfterLogin(page) {
  await clickIfPresent(page, IG.saveLoginInfo, 6_000);
  await clickIfPresent(page, IG.dismissDialog, 4_000);
}

/**
 * Вход в Threads. Отдельного пароля нет — Threads пускает аккаунтом Instagram, поэтому здесь
 * только подтверждение уже открытой сессии. Если сессии Instagram нет, сначала нужен loginInstagram.
 */
export async function ensureThreads({ context, shotsDir = null, log = () => {} }) {
  if (await hasSession(context, THREADS_ORIGIN)) {
    log('Threads: сессия уже живая');
    return { ok: true };
  }
  if (!(await hasSession(context, IG_ORIGIN))) {
    return { ok: false, reason: 'нет сессии Instagram — Threads входит только через неё' };
  }

  const page = await context.newPage();
  try {
    await page.goto(THREADS.loginUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });
    await clickIfPresent(page, IG.cookieBanner, 4_000);

    const clicked = await clickIfPresent(page, THREADS.continueWithInstagram, 10_000);
    if (!clicked) {
      return {
        ok: false,
        reason: 'на странице Threads не нашлась кнопка входа через Instagram',
        screenshot: await shoot(page, shotsDir, 'threads-no-button'),
      };
    }

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await hasSession(context, THREADS_ORIGIN)) {
        log('Threads: вход выполнен аккаунтом Instagram');
        return { ok: true };
      }
      await page.waitForTimeout(700);
    }

    return {
      ok: false,
      reason: 'Threads не подтвердил вход за отведённое время',
      screenshot: await shoot(page, shotsDir, 'threads-timeout'),
    };
  } catch (err) {
    return { ok: false, reason: `вход в Threads не дошёл до конца: ${err.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Высокоуровневый вход: обе площадки за один запуск браузера.
 * Threads пробуем даже если Instagram уже был залогинен — сессии у них раздельные.
 */
export async function loginBoth({ context, login, password, askCode = null, shotsDir = null, log = () => {} }) {
  const ig = await loginInstagram({ context, login, password, askCode, shotsDir, log });
  if (!ig.ok) return { instagram: ig, threads: { ok: false, reason: 'пропущен: нет сессии Instagram' } };

  const threads = await ensureThreads({ context, shotsDir, log });
  return { instagram: ig, threads };
}
