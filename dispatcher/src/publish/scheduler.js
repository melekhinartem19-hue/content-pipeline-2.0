// Планировщик отложенных публикаций (T08).
//
// Нужен только для элементов со слотом контент-календаря: «Одобрить» публикует сразу, а если у
// элемента задан слот на будущее — он ждёт здесь. Никакого cron: раз в минуту смотрим в БД, что
// уже пора. Состояние в БД, поэтому перезапуск процесса ничего не теряет — отложенное уйдёт,
// когда диспетчер снова поднимется (в том числе позже слота).

import { nowStamp, publishItem } from './index.js';

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Запускает периодическую проверку. Возвращает функцию остановки.
 * @param {object} o
 * @param {object} o.db
 * @param {Map<string,{bot:object, identity:object}>} o.botsByKey
 * @param {number|string|null} o.channelId
 * @param {number} [o.intervalMs]
 * @param {Function} [o.onPublished]  колбэк «опубликовано/не удалось» (уведомление в топик)
 * @returns {() => void}  остановка таймера
 */
export function startPublishScheduler({ db, botsByKey, channelId, intervalMs = DEFAULT_INTERVAL_MS, onPublished = null }) {
  const tick = async () => {
    let due;
    try {
      due = db.queue.listDueScheduled(nowStamp());
    } catch (err) {
      console.error('[scheduler] не смог прочитать очередь:', err.message);
      return;
    }

    for (const item of due) {
      // now передаём явно и «сейчас»: слот уже наступил, иначе элемент бы не выбрался запросом.
      const res = await publishItem({ db, item, botsByKey, channelId, now: item.slot_at });
      console.log(`[scheduler] #${item.id} по слоту ${item.slot_at} → ${res.status}${res.error ? `: ${res.error}` : ''}`);
      if (onPublished) await onPublished(item, res).catch((err) => console.error('[scheduler] уведомление:', err));
    }
  };

  const timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler] tick error:', err));
  }, intervalMs);
  timer.unref?.(); // планировщик не должен держать процесс живым сам по себе

  return () => clearInterval(timer);
}
