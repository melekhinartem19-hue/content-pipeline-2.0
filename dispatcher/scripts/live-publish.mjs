// ЖИВОЙ прогон публикации (T08): реальный бот Издателя, реальный TG-канал из .env.
//
// ⚠ Скрипт ПУБЛИКУЕТ СООБЩЕНИЕ В КАНАЛ. Запускать осознанно:
//   cd dispatcher && npm run live:t08 "текст поста"
//
// Что проверяет: путь «одобренный элемент очереди → пост в канале → статус published + id
// сообщения в БД». Нажатие кнопки «Одобрить» здесь не участвует (callback приходит только от
// живого человека) — оно проверяется вручную в группе.

import { Bot } from 'grammy';
import { enabledIdentities } from '../src/bots/registry.js';
import { openDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { publishItem } from '../src/publish/index.js';

const text = process.argv[2] || 'Тестовый пост контент-конвейера. Если ты это видишь — публикация работает.';

if (!config.tgChannelId) throw new Error('TG_CHANNEL_ID не задан в .env');
const publisher = enabledIdentities().find((i) => i.key === 'publisher');
if (!publisher) throw new Error('Издатель не поднят: нет BOT_TOKEN_PUBLISHER в .env');

const botsByKey = new Map([['publisher', { identity: publisher, bot: new Bot(publisher.token) }]]);
const db = openDb();

// Элемент кладём сразу одобренным: имитируем состояние ПОСЛЕ нажатия «Одобрить».
const id = db.queue.add({
  platform: 'tg',
  agent: 'writer',
  kind: 'tg_post',
  title: 'Живая проверка T08',
  content: text,
  status: 'approved',
  meta: { source: 'live-publish' },
});
db.queue.decide(id, 'approved', { by: 'live-publish' });

console.log(`Публикую #${id} в ${config.tgChannelId} …`);
const res = await publishItem({ db, item: db.queue.getById(id), botsByKey, channelId: config.tgChannelId });
console.log('результат:', res);

const row = db.queue.getById(id);
console.log(`в БД: status=${row.status} message_id=${row.published_message_id} at=${row.published_at}`);
if (row.publish_error) console.log('ошибка:', row.publish_error);

db.close();
console.log(res.status === 'published' ? '\n✓ живая публикация прошла — смотри канал' : '\n✗ публикация не прошла');
