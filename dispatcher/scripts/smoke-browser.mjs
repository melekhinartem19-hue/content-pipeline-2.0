// Смоук-тест браузерной публикации (вариант C): IG_MODE=browser.
//
// ОФФЛАЙН И БЕЗ БРАУЗЕРА. Chromium здесь не запускается ни разу, в Instagram не уходит ничего.
// Проверяется то, что вообще можно проверить без живого аккаунта:
//   • переключатель IG_MODE действительно меняет путь публикации и ничего не ломает в режиме api;
//   • сухой прогон показывает план и НЕ открывает браузер;
//   • отказы случаются ДО запуска браузера (нет картинок, пустой текст, длинная подпись);
//   • разбор адреса проверки входа.
//
// Чего этот смоук проверить НЕ МОЖЕТ (и не делает вид, что может): селекторы формы входа и
// мастера публикации. Они проверяются только живым прогоном на аккаунте клиента.
//
// Запуск: node dispatcher/scripts/smoke-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { browserReady, publishViaBrowser } from '../src/publish/browser/index.js';
import { isChallengeUrl } from '../src/publish/browser/session.js';
import { hasPendingCode, parseLoginCommand, submitCode, __testing } from '../src/publish/browser/login-command.js';
import { platformStatuses } from '../src/publish/index.js';

// ── Стенд: нарисованные кадры на диске ────────────────────────────────────
const rendersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-browser-'));
const frames = ['slide-1.png', 'slide-2.png'].map((name) => {
  const file = path.join(rendersDir, name);
  fs.writeFileSync(file, 'PNG');
  return file;
});

const base = {
  igMode: 'browser',
  igLogin: 'client_account',
  igPassword: 'secret',
  igProfileDir: path.join(rendersDir, 'profile'),
  igShotsDir: path.join(rendersDir, 'shots'),
  igHeadful: false,
  publishDryRun: true, // ГЛАВНОЕ: браузер не должен запуститься ни в одном тесте ниже
  publicDir: rendersDir,
  videoPublicSubdir: 'video',
};

const item = (over = {}) => ({ id: 1, platform: 'ig', kind: 'carousel', content: 'текст', meta: {}, ...over });

// ── Готовность: без кредов публиковать нечем ──────────────────────────────
assert.equal(browserReady(base).ok, true, 'с логином и паролем браузерный путь готов');
assert.match(
  browserReady({ ...base, igPassword: null }).error,
  /IG_PASSWORD/,
  'без пароля причина называет недостающую переменную',
);

// ── Сухой прогон: план есть, браузера нет ─────────────────────────────────
const dryIg = await publishViaBrowser({
  item: item({ meta: { images: frames, caption: 'подпись поста' } }),
  config: base,
});
assert.equal(dryIg.dryRun, true, 'сухой прогон помечен');
assert.equal(dryIg.ref, null, 'в сухом прогоне ссылки на пост быть не может');
assert.ok(
  dryIg.plan.some((s) => /загрузить файлов: 2/.test(s.url)),
  'план называет число загружаемых файлов',
);
assert.ok(
  dryIg.plan.some((s) => /подпись \(13 знаков\)/.test(s.url)),
  'план называет длину подписи',
);

const dryThreads = await publishViaBrowser({
  item: item({ platform: 'threads', kind: 'threads_post', content: 'короткий пост' }),
  config: base,
});
assert.ok(
  dryThreads.plan.some((s) => /Post/.test(s.url)),
  'у Threads свой план без мастера и без файлов',
);

// ── Отказы происходят ДО запуска браузера ─────────────────────────────────
// Это важно не для красоты: запуск Chromium — секунды, и бессмысленный пост не должен их тратить.
const noImages = await publishViaBrowser({ item: item({ meta: {} }), config: base });
assert.equal(noImages.skip, true, 'без картинок публикация пропускается');
assert.match(noImages.reason, /рендер/, 'причина подсказывает, что делать');

const missingFile = await publishViaBrowser({
  item: item({ meta: { images: [path.join(rendersDir, 'нет-такого.png')] } }),
  config: base,
});
assert.equal(missingFile.skip, true, 'путь есть, а файла на диске нет — тоже пропуск');

const script = await publishViaBrowser({ item: item({ kind: 'reels_script', meta: {} }), config: base });
assert.match(script.reason, /сценарий Reels/, 'сценарий — не ролик, публиковать нечего');

const urlOnly = await publishViaBrowser({
  item: item({ kind: 'reels_script', meta: { video_url: 'https://example.com/v.mp4' } }),
  config: base,
});
assert.match(urlOnly.reason, /файл на диске/, 'браузеру нужен файл, а не публичная ссылка');

const emptyThreads = await publishViaBrowser({
  item: item({ platform: 'threads', content: '   ' }),
  config: base,
});
assert.equal(emptyThreads.skip, true, 'пустой текст в Threads не публикуется');

// Лимиты — исключение, а не тихая обрезка: владелец одобрил конкретный текст.
await assert.rejects(
  () => publishViaBrowser({ item: item({ meta: { images: frames, caption: 'я'.repeat(2201) } }), config: base }),
  /2200/,
  'слишком длинная подпись отклоняется с числом',
);

await assert.rejects(
  () =>
    publishViaBrowser({
      item: item({ meta: { images: Array.from({ length: 11 }, () => frames[0]) } }),
      config: base,
    }),
  /не больше 10/,
  'карусель длиннее 10 кадров отклоняется, а не режется молча',
);

// ── Переключатель IG_MODE ─────────────────────────────────────────────────
// В режиме browser готовность площадок считается по логину-паролю, а не по токенам Meta.
const browserMode = platformStatuses({ config: { ...base, publishDryRun: false } });
const igBrowser = browserMode.find((p) => p.platform === 'ig');
const thBrowser = browserMode.find((p) => p.platform === 'threads');
assert.equal(igBrowser.ok, true, 'IG_MODE=browser: Instagram готов без IG_ACCESS_TOKEN');
assert.equal(thBrowser.ok, true, 'IG_MODE=browser: Threads готов без своего токена — сессия общая');

// А в режиме api всё по-прежнему упирается в токены: старый путь не задет.
const apiMode = platformStatuses({ config: { ...base, igMode: 'api' } });
assert.match(
  apiMode.find((p) => p.platform === 'ig').error,
  /IG_USER_ID/,
  'IG_MODE=api: поведение прежнее, нужны токены Meta',
);

// ── Разбор адреса проверки входа ──────────────────────────────────────────
assert.equal(isChallengeUrl('https://www.instagram.com/challenge/action/'), true, 'чекпойнт опознан');
assert.equal(isChallengeUrl('https://www.instagram.com/accounts/login/two_factor'), true, '2FA опознана');
assert.equal(isChallengeUrl('https://www.instagram.com/'), false, 'обычная страница не чекпойнт');

// ── Команда «/вход» в топике Издателя ─────────────────────────────────────
assert.deepEqual(parseLoginCommand('/вход'), { action: 'login' }, 'слеш-команда распознана');
assert.deepEqual(parseLoginCommand('/вход статус'), { action: 'status' }, 'аргумент «статус» распознан');
assert.deepEqual(parseLoginCommand('перезайди'), { action: 'login' }, 'то же словами, без слеша');
assert.deepEqual(parseLoginCommand('сессия'), { action: 'status' }, 'статус словами');

// Живая речь про вход НЕ должна запускать браузер — она уходит агенту. Тот же принцип, что у «/тренды».
assert.equal(parseLoginCommand('не могу войти в инсту, что делать'), null, 'фраза про вход — не команда');
assert.equal(parseLoginCommand('вход в аккаунт клиента сломался'), null, 'фраза длиннее команды — не команда');
assert.equal(parseLoginCommand('расскажи про вход'), null, 'упоминание входа — не команда');

// ── Реестр ожидающих кодов ────────────────────────────────────────────────
const { pending } = __testing;
let delivered = null;
const timer = setTimeout(() => {}, 1000);
pending.set(555, { resolve: (code) => (delivered = code), timer });

assert.equal(hasPendingCode(555), true, 'карточка ждёт код');
assert.equal(hasPendingCode(999), false, 'чужая карточка ничего не ждёт');
assert.equal(submitCode(999, '123456'), 'not-pending', 'код без ожидающей карточки никуда не идёт');

// Ответ без цифр НЕ снимает ожидание: промах реплаем не должен заставлять входить заново.
assert.equal(submitCode(555, 'сейчас посмотрю'), 'no-digits', 'ответ без цифр отклонён');
assert.equal(hasPendingCode(555), true, 'после ответа без цифр попытка входа ещё жива');
assert.equal(delivered, null, 'и код в браузер не ушёл');

// Код вынимается из живого текста, а не требует чистой формы.
assert.equal(submitCode(555, 'код 123 456'), 'accepted', 'код из живого текста принят');
assert.equal(delivered, '123456', 'из «код 123 456» достались только цифры');
assert.equal(hasPendingCode(555), false, 'принятый код снимает ожидание');
clearTimeout(timer);

fs.rmSync(rendersDir, { recursive: true, force: true });
console.log('✓ smoke-browser PASS — переключатель, сухой прогон, отказы до браузера и приём кода из топика');
