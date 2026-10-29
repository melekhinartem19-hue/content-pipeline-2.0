// Роутер форум-группы (T03). Решает, должен ли данный бот обрабатывать входящее сообщение.
//
// Модель: каждый бот — своё подключение (свой токен), поэтому «маршрутизация» сводится к фильтру
// «это моё сообщение или чужое»:
//   • личка 1:1 с ботом            → да (это его личный диалог);
//   • топик форум-группы           → только если это ЕГО топик (message_thread_id === topicId);
//   • чужой топик / «General» / пр. → нет (тихо игнорируем, чтобы 6 ботов не дублировали обработку).
//
// Так сообщение в топик агента доходит именно до его обработчика — критерий демо T03.

/**
 * @param {{topicId:number|null}} identity  резолвнутая идентичность (см. registry.resolveIdentity)
 * @param {import('grammy').Context} ctx
 * @returns {boolean}
 */
export function shouldHandle(identity, ctx) {
  const type = ctx.chat?.type;
  if (type === 'private') return true;
  if (type === 'group' || type === 'supergroup') {
    if (identity.topicId == null) return false; // у бота нет закреплённого топика → группу не слушает
    return ctx.message?.message_thread_id === identity.topicId;
  }
  return false; // каналы и прочее не обрабатываем
}

// ── Allowlist владельцев (кто вообще имеет право говорить с ботами) ─────────────────────
//
// ЗАЧЕМ. Фильтр выше отвечает на вопрос «в правильном ли месте написали», но не на вопрос «кто
// написал». Без allowlist любой, кто узнал @username бота, пишет ему в личку — и каждое такое
// сообщение уходит в `claude -p` на Pro-подписке КЛИЕНТА. Это не утечка данных (мозг бренда
// посторонний не увидит), это счёт за чужие запросы и упёршиеся лимиты подписки в рабочий день.
//
// ПУСТОЙ СПИСОК = ФИЛЬТР ВЫКЛЮЧЕН. Так задумано: локальная отладка и первый запуск на VPS идут
// до того, как известны user_id, и «забыл заполнить» не должно превращаться в «всё молчит».
// На боевом сервере OWNER_IDS заполняется обязательно — см. dispatcher/.env.example.

/** Парсит OWNER_IDS («12345,67890») в Set чисел. Пусто/мусор → пустой Set (фильтр выключен). */
export function parseOwnerIds(raw) {
  if (!raw || !String(raw).trim()) return new Set();
  return new Set(
    String(raw)
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

/**
 * Разрешено ли этому пользователю говорить с ботами.
 * @param {import('grammy').Context} ctx
 * @param {Set<number>} ownerIds  пустой Set → разрешено всем (фильтр выключен)
 * @returns {boolean}
 */
export function isOwner(ctx, ownerIds) {
  if (!ownerIds || ownerIds.size === 0) return true;
  const id = ctx.from?.id;
  return typeof id === 'number' && ownerIds.has(id);
}
