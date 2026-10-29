// Поиск и запуск headless Chromium для рендера слайдов (T10).
//
// ПОЧЕМУ playwright-core, А НЕ playwright. Пакет `playwright` при установке тянет свои сборки
// браузеров (сотни мегабайт) и привязывается к их ревизии. `playwright-core` — только клиент
// протокола: браузер мы находим сами и передаём путём. Поэтому подходит ЛЮБОЙ уже стоящий
// Chromium/Chrome/Edge — и на ноуте разработчика, и на VPS (`apt install chromium`), и в
// кэше playwright, если он там оказался. Обновление системного Chrome не ломает рендер.
//
// Порядок поиска — от явного к общему; первый найденный исполняемый файл выигрывает:
//   1) RENDER_BROWSER из .env      — ручное переопределение, последнее слово всегда за клиентом;
//   2) кэш playwright              — ~/.cache/ms-playwright (Linux) / %LOCALAPPDATA% (Windows);
//   3) системный Chrome/Chromium   — обычные пути дистрибутивов;
//   4) Edge (только Windows)       — тот же движок, выручает, если Chrome не ставили.
//
// Ничего не нашли → внятная ошибка с командой установки, а не «Executable doesn't exist».

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Путь к браузеру или null. Синхронно: вызывается один раз на запуск рендера. */
export function findBrowser(env = process.env) {
  const explicit = env.RENDER_BROWSER?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : null;

  for (const p of candidatePaths(env)) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** Все места, где может лежать браузер на этой ОС (в порядке предпочтения). */
function candidatePaths(env) {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const cacheRoots = win
    ? [path.join(local, 'ms-playwright')]
    : [path.join(home, '.cache', 'ms-playwright'), '/ms-playwright'];

  const fromCache = cacheRoots.flatMap(playwrightCacheBinaries);

  const system = win
    ? [
        path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/snap/bin/chromium',
        ];

  return [...fromCache, ...system];
}

/**
 * Сборки внутри кэша playwright. Имена папок содержат ревизию (chromium-1228), поэтому
 * читаем каталог и берём самую свежую — жёстко зашитая ревизия протухла бы при обновлении.
 */
function playwrightCacheBinaries(root) {
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const rev = (name) => Number(/(\d+)$/.exec(name)?.[1] || 0);
  // Полный chromium предпочтительнее headless_shell: одинаково рендерит, но умеет больше,
  // если однажды понадобится отладить композицию с открытым окном.
  const builds = dirs
    .filter((d) => d.startsWith('chromium-') || d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => rev(b) - rev(a) || (a.startsWith('chromium-') ? -1 : 1));

  const suffixes =
    process.platform === 'win32'
      ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-headless-shell-win64/chrome-headless-shell.exe']
      : process.platform === 'darwin'
        ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-headless-shell-mac/chrome-headless-shell']
        : [
            'chrome-linux/chrome',
            'chrome-headless-shell-linux64/chrome-headless-shell',
            'chrome-headless-shell-linux/chrome-headless-shell',
          ];

  return builds.flatMap((b) => suffixes.map((s) => path.join(root, b, ...s.split('/'))));
}

/** Текст ошибки «браузера нет» — с готовыми командами, чтобы клиенту не гадать. */
export const NO_BROWSER_HINT = [
  'не найден headless-браузер для рендера картинок.',
  'Поставь один из вариантов и повтори:',
  '  • Linux/VPS:  sudo apt-get install -y chromium fonts-dejavu fonts-noto-core',
  '  • или:        npx playwright install --with-deps chromium',
  '  • Windows:    достаточно установленного Google Chrome',
  'Свой путь можно задать явно: RENDER_BROWSER=/полный/путь/к/chrome в dispatcher/.env',
].join('\n');

/**
 * Запускает браузер. Возвращает объект с методом close().
 * @param {object} [o]
 * @param {string} [o.executablePath]  путь к браузеру (по умолчанию — findBrowser())
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchBrowser({ executablePath = null } = {}) {
  const bin = executablePath || findBrowser();
  if (!bin) throw new Error(NO_BROWSER_HINT);

  // Импорт внутри функции: без рендера playwright-core грузить незачем, а смоук-тесты
  // парсера и вёрстки должны работать даже там, где браузера нет вовсе.
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    executablePath: bin,
    // --no-sandbox нужен на большинстве VPS: рендер идёт под непривилегированным пользователем
    // в контейнере/без user namespaces, иначе Chromium не стартует вообще.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
}
