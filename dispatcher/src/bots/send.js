// Исходящие хелперы Telegram: нарезка под лимит сообщения и адресная отправка в топик.
//
// В форум-группе обычный обработчик отвечает только в СВОЙ топик (message_thread_id входящего).
// Продюсеру-оркестратору нужно уметь писать в ЧУЖИЕ топики — раздавать задачи; для этого
// postToTopic задаёт целевой топик ЯВНО, а не берёт его из входящего сообщения.
// Вызывающий — оркестрация Продюсера (T05, src/orchestrator.js): ТЗ в топик исполнителя постит
// бот-Продюсер, готовый черновик туда же — бот-исполнитель.

export const TG_LIMIT = 4096; // максимум символов в одном сообщении Telegram

/** Режет текст на куски ≤ TG_LIMIT. Пустой вход → всегда ровно один кусок-заглушка. */
export function splitForTelegram(text) {
  const safe = text && text.length ? text : '(пустой ответ)';
  const parts = [];
  for (let i = 0; i < safe.length; i += TG_LIMIT) parts.push(safe.slice(i, i + TG_LIMIT));
  return parts;
}

/**
 * Отправляет текст в конкретный топик форум-группы от имени переданного бота.
 * Топик задаётся явно (а не берётся из входящего) — так Продюсер постит в чужие топики.
 * Длинный текст режется по TG_LIMIT.
 * @param {import('grammy').Bot} bot  бот, от имени которого шлём (обычно Продюсер)
 * @param {number|string} groupId    id форум-группы (FORUM_GROUP_ID)
 * @param {number} topicId           id целевого топика (= message_thread_id)
 * @param {string} text              текст сообщения
 */
export async function postToTopic(bot, groupId, topicId, text) {
  for (const part of splitForTelegram(text)) {
    await bot.api.sendMessage(groupId, part, { message_thread_id: topicId });
  }
}
