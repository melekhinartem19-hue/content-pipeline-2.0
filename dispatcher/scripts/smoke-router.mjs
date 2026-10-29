// Смоук-тест роутера (T03) БЕЗ Telegram: проверяем shouldHandle на поддельных ctx.
// Запуск: node dispatcher/scripts/smoke-router.mjs
import assert from 'node:assert/strict';
import { isOwner, parseOwnerIds, shouldHandle } from '../src/bots/router.js';
import { resolveIdentity } from '../src/bots/registry.js';

// Идентичность Сценариста с топиком 100 (как будто TOPIC_WRITER=100).
const writer = resolveIdentity(
  { key: 'writer', tokenEnv: 'BOT_TOKEN_WRITER', agent: 'writer', topicEnv: 'TOPIC_WRITER' },
  { BOT_TOKEN_WRITER: 'x', TOPIC_WRITER: '100' },
);
assert.equal(writer.topicId, 100, 'topicId резолвится в число');

const ctx = (chatType, threadId) => ({ chat: { type: chatType }, message: { message_thread_id: threadId } });

// Личка → всегда да.
assert.equal(shouldHandle(writer, ctx('private', undefined)), true, 'личка → обрабатываем');
// Свой топик → да.
assert.equal(shouldHandle(writer, ctx('supergroup', 100)), true, 'свой топик → обрабатываем');
// Чужой топик → нет.
assert.equal(shouldHandle(writer, ctx('supergroup', 200)), false, 'чужой топик → игнор');
// Группа без топика (General) → нет.
assert.equal(shouldHandle(writer, ctx('supergroup', undefined)), false, 'без топика → игнор');
// Канал → нет.
assert.equal(shouldHandle(writer, ctx('channel', undefined)), false, 'канал → игнор');

// Спайн-бот без своего топика: личка да, любой топик — нет.
const spine = resolveIdentity(
  { key: 'dispatcher', tokenEnv: 'TELEGRAM_BOT_TOKEN', agent: null, topicEnv: null },
  { TELEGRAM_BOT_TOKEN: 'x' },
);
assert.equal(spine.topicId, null, 'у спайна нет топика');
assert.equal(shouldHandle(spine, ctx('private', undefined)), true, 'спайн: личка → да');
assert.equal(shouldHandle(spine, ctx('supergroup', 100)), false, 'спайн: группу не слушает');

// ── Allowlist владельцев (OWNER_IDS) ──────────────────────────────────────────────────
// Проверяем ровно то, за что он отвечает: пустой список никого не блокирует (иначе первый
// запуск на VPS выглядел бы как «все боты сломались»), заполненный — пропускает только своих.
const owner = (id) => ({ from: { id } });

assert.equal(parseOwnerIds('').size, 0, 'пустая строка → фильтр выключен');
assert.equal(parseOwnerIds(undefined).size, 0, 'нет переменной → фильтр выключен');
assert.equal(parseOwnerIds('не число').size, 0, 'мусор отбрасывается, а не ломает старт');
assert.deepEqual([...parseOwnerIds('111, 222')], [111, 222], 'список через запятую с пробелами');
assert.deepEqual([...parseOwnerIds('111 222')], [111, 222], 'список через пробел');

const ids = parseOwnerIds('111,222');
assert.equal(isOwner(owner(111), ids), true, 'владелец → пускаем');
assert.equal(isOwner(owner(222), ids), true, 'второй владелец → пускаем');
assert.equal(isOwner(owner(999), ids), false, 'посторонний → не пускаем');
assert.equal(isOwner({}, ids), false, 'нет from → не пускаем');
assert.equal(isOwner(owner(999), new Set()), true, 'фильтр выключен → пускаем всех');

// Порядок фильтров: allowlist НЕ подменяет роутер. Владелец, написавший в чужой топик, всё равно
// игнорируется — иначе 6 ботов ответили бы хором на одно сообщение.
assert.equal(shouldHandle(writer, ctx('supergroup', 200)), false, 'владелец в чужом топике → игнор');

console.log('✓ smoke-router PASS — маршрутизация по топикам и allowlist владельцев');
