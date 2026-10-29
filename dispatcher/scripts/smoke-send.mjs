// Смоук-тест исходящих хелперов (T03-B) БЕЗ Telegram: проверяем нарезку под лимит и то, что
// postToTopic шлёт в заданный топик. Запуск: node dispatcher/scripts/smoke-send.mjs
import assert from 'node:assert/strict';
import { TG_LIMIT, splitForTelegram, postToTopic } from '../src/bots/send.js';

// ── splitForTelegram ──
assert.deepEqual(splitForTelegram('привет'), ['привет'], 'короткий текст → один кусок');
assert.deepEqual(splitForTelegram(''), ['(пустой ответ)'], 'пустой вход → кусок-заглушка');

const long = 'a'.repeat(TG_LIMIT * 2 + 5); // 2 полных куска + хвост
const parts = splitForTelegram(long);
assert.equal(parts.length, 3, 'длинный текст режется на 3 куска');
assert.ok(parts.every((p) => p.length <= TG_LIMIT), 'каждый кусок ≤ TG_LIMIT');
assert.equal(parts.join(''), long, 'склейка кусков = исходный текст');

// ── postToTopic ── фейковый бот записывает вызовы api.sendMessage.
const calls = [];
const fakeBot = { api: { sendMessage: async (chatId, text, opts) => calls.push({ chatId, text, opts }) } };

await postToTopic(fakeBot, -100500, 14, 'раздаю задачу');
assert.equal(calls.length, 1, 'короткое сообщение → один sendMessage');
assert.equal(calls[0].chatId, -100500, 'chatId = переданная группа');
assert.equal(calls[0].text, 'раздаю задачу', 'текст пробрасывается как есть');
assert.equal(calls[0].opts.message_thread_id, 14, 'уходит в ЗАДАННЫЙ топик, а не в чужой');

// Длинный текст → несколько sendMessage, и все в тот же топик.
calls.length = 0;
await postToTopic(fakeBot, -100500, 14, long);
assert.equal(calls.length, 3, 'длинный текст → нарезка на несколько сообщений');
assert.ok(calls.every((c) => c.opts.message_thread_id === 14), 'все куски — в один топик');
assert.equal(calls.map((c) => c.text).join(''), long, 'склейка отправленного = исходный текст');

console.log('✓ smoke-send PASS — нарезка под лимит и адресная отправка в топик работают');
