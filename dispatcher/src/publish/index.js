// Публикация одобренного контента — правила и состояние. TG (T08), Threads (T11), IG (T12).
//
// ГЛАВНОЕ ПРАВИЛО: наружу уходит ТОЛЬКО одобренный элемент. Черновик, отклонённый и отправленный
// на правку не публикуются никогда — проверка здесь, а не на стороне вызывающего, чтобы её нельзя
// было обойти по невнимательности.
//
// ТРИ ПЛОЩАДКИ — ТРИ РАЗНЫХ КАНАЛА, а не один с флажком (CLAUDE.md, правило 6):
//   tg      — Bot API, постит бот Издателя (он админ канала);
//   threads — Graph API на graph.threads.net, только текст, свой токен;
//   ig      — Graph API на graph.facebook.com, карусель/обложка/Reels, свой токен и публичные
//             ссылки на картинки.
// Поэтому у каждой площадки своя пара «готов ли» + «отправить», а не общий if.
//
// Публикуем сразу по кнопке «Одобрить». Если у элемента задан слот контент-календаря на будущее
// (`/слот <id> <когда>`), элемент уходит в `scheduled`, а отправит его планировщик (scheduler.js).

import { config as globalConfig } from '../config.js';
import { igReady, publishToInstagram } from './instagram.js';
import { publishToTelegram, pickPhoto } from './telegram.js';
import { publishToThreads, threadsReady } from './threads.js';
import { browserReady, publishViaBrowser } from './browser/index.js';
import { describePlan } from './graph.js';

/**
 * Идёт ли публикация в Instagram/Threads живым браузером вместо Graph API (вариант C).
 * Переключатель один на обе площадки: сессия у них общая — Threads входит аккаунтом Instagram.
 *
 * Оба пути остаются рабочими СПЕЦИАЛЬНО: если браузерная сессия упрётся в проверку, возврат
 * к API — это правка одной переменной в .env и перезапуск, а не откат кода.
 */
function viaBrowser(config) {
  return config?.igMode === 'browser';
}

/**
 * Площадки: как проверить готовность и как отправить. Добавление площадки = запись в этой таблице,
 * а не правка publishItem.
 */
const PLATFORMS = {
  tg: {
    ready: ({ botsByKey, channelId, publisherKey }) =>
      botsByKey?.get(publisherKey)?.bot && channelId
        ? { ok: true }
        : { ok: false, error: 'не задан TG_CHANNEL_ID или не поднят бот Издателя' },
    send: async ({ item, botsByKey, channelId, publisherKey }) => {
      const { messageId } = await publishToTelegram({
        bot: botsByKey.get(publisherKey).bot,
        channelId,
        text: item.content,
        photo: pickPhoto(item.meta),
      });
      return { messageId, ref: messageId == null ? null : String(messageId) };
    },
  },

  threads: {
    ready: ({ config }) => (viaBrowser(config) ? browserReady(config) : threadsReady(config)),
    send: ({ item, config, fetchImpl }) =>
      viaBrowser(config) ? publishViaBrowser({ item, config }) : publishToThreads({ item, config, fetchImpl }),
  },

  ig: {
    ready: ({ config }) => (viaBrowser(config) ? browserReady(config) : igReady(config)),
    send: ({ item, config, fetchImpl }) =>
      viaBrowser(config) ? publishViaBrowser({ item, config }) : publishToInstagram({ item, config, fetchImpl }),
  },
};

/** Статусы, из которых элемент вообще может уйти на публикацию. */
const PUBLISHABLE_STATUSES = new Set(['approved', 'scheduled', 'publish_failed']);

/** Локальное время в том же формате, в котором нормализуются слоты: YYYY-MM-DD HH:MM. */
export function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Публикует элемент очереди, если он к этому готов.
 * @param {object} o
 * @param {object} o.db  фасад БД
 * @param {object} o.item  элемент очереди
 * @param {Map<string,{bot:object, identity:object}>} o.botsByKey  поднятые боты (нужны только TG)
 * @param {number|string|null} o.channelId  id канала (config.tgChannelId)
 * @param {string} [o.publisherKey]  чьим ботом публикуем в TG (по умолчанию Издатель)
 * @param {string} [o.now]  «сейчас» для сравнения со слотом (инъекция для тестов)
 * @param {object} [o.config]  конфиг (инъекция для тестов)
 * @returns {Promise<{status:'published'|'scheduled'|'skipped'|'failed', messageId?:number,
 *   ref?:string, reason?:string, error?:string, note?:string}>}
 */
export async function publishItem({
  db,
  item,
  botsByKey,
  channelId,
  publisherKey = 'publisher',
  now = nowStamp(),
  config = globalConfig,
  fetchImpl = globalThis.fetch,
}) {
  if (!PUBLISHABLE_STATUSES.has(item.status)) {
    return { status: 'skipped', reason: `элемент #${item.id} в статусе ${item.status} — публиковать нельзя` };
  }

  const platform = PLATFORMS[item.platform];
  if (!platform) {
    return { status: 'skipped', reason: `площадка «${item.platform}» не поддерживается` };
  }

  // Слот на будущее — ждём планировщика. Нераспознанный слот (свободный текст) не блокирует.
  if (item.slot_at && isFutureSlot(item.slot_at, now)) {
    db.queue.markScheduled(item.id);
    return { status: 'scheduled', reason: `по слоту ${item.slot_at}` };
  }

  const ready = platform.ready({ config, botsByKey, channelId, publisherKey });
  if (!ready.ok) {
    // Настройка не доделана — это не «тихо ничего не произошло», а честный publish_failed
    // с причиной: её видно в /очередь, и после правки .env публикацию можно повторить.
    db.queue.markPublishFailed(item.id, ready.error);
    return { status: 'failed', error: ready.error };
  }

  try {
    const res = await platform.send({ item, botsByKey, channelId, publisherKey, config, fetchImpl });

    // Площадка честно сказала «мне это публиковать нечем» (например, сценарий Reels без ролика).
    if (res?.skip) return { status: 'skipped', reason: res.reason };

    // Сухой прогон: запросы никуда не ушли — значит и статус в БД менять нельзя.
    if (res?.dryRun) {
      return {
        status: 'skipped',
        reason:
          `PUBLISH_DRY_RUN=1 — в ${item.platform} ничего не отправлено. План вызовов:\n` +
          describePlan(res.plan || []),
      };
    }

    db.queue.markPublished(item.id, { messageId: res.messageId ?? null, ref: res.ref ?? null });
    return { status: 'published', messageId: res.messageId, ref: res.ref, note: res.note || undefined };
  } catch (err) {
    // Типичное: бот не админ канала, протухший токен Meta, недоступная картинка, сеть.
    // Причина остаётся в БД, элемент можно опубликовать повторно после починки.
    db.queue.markPublishFailed(item.id, err.message);
    return { status: 'failed', error: err.message };
  }
}

/** Слот в будущем? Строка сравнивается лексикографически — формат YYYY-MM-DD HH:MM это позволяет. */
export function isFutureSlot(slotAt, now = nowStamp()) {
  const s = String(slotAt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return false; // свободный текст расписанием не считаем
  return s > now;
}

/** Какие площадки настроены, а какие ждут кредов, — для стартового лога и диагностики. */
export function platformStatuses({ config = globalConfig, botsByKey = null, channelId = null } = {}) {
  return Object.entries(PLATFORMS).map(([platform, impl]) => ({
    platform,
    ...impl.ready({ config, botsByKey, channelId, publisherKey: 'publisher' }),
  }));
}
