// Вход в аккаунты клиента прямо из топика Издателя: «/вход».
//
// ЗАЧЕМ. Без этого модуля умершая сессия чинится только по SSH: `npm run ig:login` на сервере.
// А умирает она предсказуемо — Instagram разлогинивает по смене пароля, подозрительной
// активности или просто по сроку. Владелец в этот момент сидит в Telegram, а не в консоли.
//
// КАК УСТРОЕНО. Код подтверждения спрашивается КАРТОЧКОЙ СО СКРИНШОТОМ в топике Издателя, а
// ответ принимается РЕПЛАЕМ на неё — тот же механизм, что у «Правки» в очереди согласования
// (см. index.js). Реплай однозначно связывает код с конкретной попыткой входа: если карточек
// почему-то две, ответ не уйдёт не туда.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ОЧЕРЕДИ. Связь «сообщение ↔ элемент» у очереди лежит в БД, потому что
// согласование обязано пережить перезапуск диспетчера. Здесь — намеренно в ПАМЯТИ: попытка
// входа привязана к живому браузеру, и пережить перезапуск она не может физически. Упал
// диспетчер во время входа — вход начинается заново, и это честнее, чем воскрешать ссылку
// на закрытый браузер.
//
// Обхода проверки здесь нет: код вводит человек, владеющий аккаунтом.

import { InputFile } from 'grammy';

import { openSession, sessionState, loginBoth } from './session.js';

/** Сколько ждём код от владельца. Десять минут — чтобы успеть дойти до почты или телефона. */
const CODE_WAIT_MS = 10 * 60 * 1000;

/**
 * Ожидающие кода попытки входа: message_id карточки → как её разбудить.
 * В памяти процесса намеренно — см. шапку файла.
 * @type {Map<number, {resolve: Function, timer: NodeJS.Timeout}>}
 */
const pending = new Map();

/** Ждёт ли эта карточка код. Дёргается роутером на каждый реплай — должно быть дёшево. */
export function hasPendingCode(messageId) {
  return pending.has(messageId);
}

/**
 * Передать код ожидающей попытке входа.
 *
 * Ответ без цифр ожидание НЕ СНИМАЕТ: владелец мог промахнуться реплаем или написать «сейчас
 * посмотрю». Если бы такой ответ закрывал попытку, вход пришлось бы начинать заново из-за
 * случайного сообщения — а каждый лишний вход повышает риск проверки.
 *
 * @returns {'accepted'|'no-digits'|'not-pending'}
 */
export function submitCode(messageId, text) {
  const entry = pending.get(messageId);
  if (!entry) return 'not-pending';

  // Из «код 123456» и «123 456» достаём цифры: владелец пишет живым текстом, а не по форме.
  const digits = String(text || '').replace(/\D+/g, '');
  if (!digits) return 'no-digits';

  pending.delete(messageId);
  clearTimeout(entry.timer);
  entry.resolve(digits);
  return 'accepted';
}

/** Снять ожидание, если вход оборвался по другой причине — иначе карточка висела бы до таймаута. */
function dropPending(messageId) {
  const entry = pending.get(messageId);
  if (!entry) return;
  pending.delete(messageId);
  clearTimeout(entry.timer);
}

/**
 * Делает функцию askCode, которая спрашивает код карточкой в топике Издателя.
 * @param {object} o
 * @param {object} o.bot      бот Издателя (его карточка — ему и отвечают реплаем)
 * @param {number|string} o.chatId
 * @param {number} [o.topicId]
 * @returns {Function} async ({reason, screenshot, url}) => код|null
 */
export function makeTelegramAskCode({ bot, chatId, topicId = null }) {
  const opts = topicId ? { message_thread_id: topicId } : {};

  return async ({ reason, screenshot, url }) => {
    const caption = [
      `🔐 ${reason}`,
      '',
      'Код придёт на почту или телефон аккаунта (при 2FA — в приложении).',
      '',
      '👉 Ответь РЕПЛАЕМ на это сообщение и пришли код.',
      `Жду ${CODE_WAIT_MS / 60000} минут, потом вход придётся начать заново.`,
      '',
      `Страница: ${url}`,
    ].join('\n');

    // Скриншот показывает, КУДА Instagram отправил код и не заблокирован ли аккаунт.
    // Если снимок не получился, текст всё равно уходит: без картинки хуже, чем без кода.
    let msg;
    try {
      msg = screenshot
        ? await bot.api.sendPhoto(chatId, new InputFile(screenshot), { caption, ...opts })
        : await bot.api.sendMessage(chatId, caption, opts);
    } catch {
      msg = await bot.api.sendMessage(chatId, caption, opts).catch(() => null);
    }
    if (!msg?.message_id) return null;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(msg.message_id);
        bot.api
          .sendMessage(chatId, '⌛ Код так и не пришёл — вход отменён. Повтори «/вход», когда будешь готов.', opts)
          .catch(() => {});
        resolve(null);
      }, CODE_WAIT_MS);

      pending.set(msg.message_id, { resolve, timer });
    });
  };
}

/**
 * «/вход» в топике Издателя — и то же самое словами, без слеша.
 * @returns {{action:'login'|'status'}|null}
 */
export function parseLoginCommand(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  const slash = /^\/(вход|login|signin)(?:@\S+)?(?![\p{L}\p{N}_])\s*(.*)$/su.exec(t);
  if (slash) {
    return { action: /^(статус|status|состояние)/iu.test(slash[2].trim()) ? 'status' : 'login' };
  }

  // Фраза распознаётся ЦЕЛИКОМ: живая речь про вход («не могу войти в инсту, что делать»)
  // должна уйти агенту, а не запускать браузер. Тот же принцип, что у «/тренды» (T09).
  if (/^(вход|войти|залогинься|зайди в аккаунт|перезайди)[\s!.?…]*$/iu.test(t)) return { action: 'login' };
  if (/^(статус входа|статус сессии|сессия|я залогинен\??)[\s!.?…]*$/iu.test(t)) return { action: 'status' };

  return null;
}

/** Состояние сессий словами — ответ на «/вход статус». Браузер открывается, но никуда не ходит. */
export async function renderSessionStatus({ config }) {
  if (config.igMode !== 'browser') {
    return [
      'ℹ️ Сейчас публикация идёт через Graph API (IG_MODE=api) — браузерная сессия не используется.',
      'Проверить настройку API: «/проверка».',
    ].join('\n');
  }

  let session;
  try {
    session = await openSession({ profileDir: config.igProfileDir, headless: !config.igHeadful });
  } catch (err) {
    return `⚠️ Браузер не запустился: ${err.message}`;
  }

  try {
    const state = await sessionState(session.context);
    return [
      '🔐 Сессии в аккаунте клиента',
      '',
      `Instagram: ${state.instagram ? '✅ вход есть' : '❌ входа нет'}`,
      `Threads:   ${state.threads ? '✅ вход есть' : '❌ входа нет'}`,
      '',
      state.instagram && state.threads
        ? 'Всё на месте — входить повторно не нужно и не надо.'
        : 'Починить: «/вход» здесь же. Код подтверждения пришлёшь реплаем.',
    ].join('\n');
  } finally {
    await session.close();
  }
}

/**
 * Выполняет вход в обе площадки, спрашивая код в топике.
 * @returns {Promise<string>} отчёт для топика
 */
export async function runLoginFromTopic({ bot, chatId, topicId = null, config, log = () => {} }) {
  if (config.igMode !== 'browser') {
    return 'ℹ️ Сейчас IG_MODE=api — публикация идёт через Graph API, браузерный вход не нужен.';
  }
  if (!config.igLogin || !config.igPassword) {
    return '⚠️ Не заданы IG_LOGIN и IG_PASSWORD в dispatcher/.env — входить нечем.';
  }

  let session;
  try {
    session = await openSession({ profileDir: config.igProfileDir, headless: !config.igHeadful });
  } catch (err) {
    return `⚠️ Браузер не запустился: ${err.message}`;
  }

  const askCode = makeTelegramAskCode({ bot, chatId, topicId });

  try {
    const before = await sessionState(session.context);
    if (before.instagram && before.threads) {
      return '✅ Обе сессии уже живые — вход не нужен. Лишний вход только повышает риск проверки.';
    }

    const res = await loginBoth({
      context: session.context,
      login: config.igLogin,
      password: config.igPassword,
      askCode,
      shotsDir: config.igShotsDir,
      log,
    });

    const lines = [
      '🔐 Вход в аккаунт клиента',
      '',
      `Instagram: ${res.instagram.ok ? '✅ выполнен' : `❌ ${res.instagram.reason}`}`,
      `Threads:   ${res.threads.ok ? '✅ выполнен' : `❌ ${res.threads.reason}`}`,
    ];
    if (res.instagram.ok && res.threads.ok) {
      lines.push('', 'Сессия сохранена и переживёт перезапуск. Публиковать можно.');
    }
    return lines.join('\n');
  } catch (err) {
    return `⚠️ Вход не дошёл до конца: ${err.message}`;
  } finally {
    await session.close();
  }
}

// Экспорт для смоука: реестр — состояние модуля, и его надо уметь проверить.
export const __testing = { pending, dropPending, CODE_WAIT_MS };
