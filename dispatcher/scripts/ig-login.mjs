// Разовый вход в Instagram и Threads живым браузером: npm run ig:login
//
// Запускается РУКАМИ на VPS один раз, когда приехали креды клиента. Дальше сессия живёт в папке
// профиля (config.igProfileDir) и переживает перезапуск диспетчера и перезагрузку сервера —
// повторно логиниться не нужно и НЕ НАДО: серия входов уводит аккаунт в проверку.
//
// Почему руками, а не автоматически при старте: первый вход почти наверняка потребует кода
// подтверждения, а код приходит человеку. Здесь его вводят прямо в консоль. Когда диспетчер уже
// работает, тот же код можно будет прислать в топик Издателя (это следующий шаг T19).
//
// Команда НИЧЕГО НЕ ПУБЛИКУЕТ — только заходит в аккаунт и показывает состояние сессий.
//
// Код возврата: 0 — обе площадки залогинены, 1 — нет.

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { config } from '../src/config.js';
import { openSession, sessionState, loginBoth } from '../src/publish/browser/session.js';

const log = (msg) => console.log(`   ${msg}`);

/** Код подтверждения спрашиваем у человека за консолью. Обхода проверки здесь нет — и не будет. */
async function askCodeFromConsole({ reason, screenshot, url }) {
  console.log(`\n⚠️  ${reason}`);
  console.log(`   Страница: ${url}`);
  if (screenshot) console.log(`   Скриншот: ${screenshot}  ← открой, чтобы увидеть, куда ушёл код`);
  console.log('   Код придёт на почту или телефон, привязанные к аккаунту (при 2FA — в приложении).');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const code = await rl.question('   Введи код (пустая строка — отмена): ');
    return code.trim() || null;
  } finally {
    rl.close();
  }
}

console.log('Вход в аккаунты клиента живым браузером\n');
console.log(`Профиль браузера: ${config.igProfileDir}`);
console.log(`Режим публикации: IG_MODE=${config.igMode}${config.igMode === 'browser' ? '' : '  ← сейчас публикация идёт через API'}`);

if (!config.igLogin || !config.igPassword) {
  console.error('\n❌ Не заданы IG_LOGIN и IG_PASSWORD в dispatcher/.env — входить нечем.');
  process.exit(1);
}
console.log(`Аккаунт: ${config.igLogin}\n`);

let session;
try {
  session = await openSession({
    profileDir: config.igProfileDir,
    headless: !config.igHeadful,
  });
} catch (err) {
  console.error(`\n❌ Браузер не запустился: ${err.message}`);
  process.exit(1);
}

try {
  const before = await sessionState(session.context);
  console.log(`Сейчас: Instagram ${before.instagram ? '✅ вход есть' : '— входа нет'}, Threads ${before.threads ? '✅ вход есть' : '— входа нет'}\n`);

  if (before.instagram && before.threads) {
    console.log('✅ Обе сессии уже живые — входить повторно не нужно.');
    process.exit(0);
  }

  const res = await loginBoth({
    context: session.context,
    login: config.igLogin,
    password: config.igPassword,
    askCode: askCodeFromConsole,
    shotsDir: config.igShotsDir,
    log,
  });

  console.log('\n── Итог ──────────────────────────────────────────');
  console.log(`Instagram: ${res.instagram.ok ? '✅ вход выполнен' : `❌ ${res.instagram.reason}`}`);
  if (res.instagram.screenshot) console.log(`           скриншот: ${res.instagram.screenshot}`);
  console.log(`Threads:   ${res.threads.ok ? '✅ вход выполнен' : `❌ ${res.threads.reason}`}`);
  if (res.threads.screenshot) console.log(`           скриншот: ${res.threads.screenshot}`);

  const ok = res.instagram.ok && res.threads.ok;
  if (ok) {
    console.log('\nСессия сохранена в профиле и переживёт перезапуск. Повторно входить не нужно.');
    console.log('Дальше: IG_MODE=browser в .env и перезапуск сервиса.');
  }
  process.exit(ok ? 0 : 1);
} finally {
  await session.close();
}
