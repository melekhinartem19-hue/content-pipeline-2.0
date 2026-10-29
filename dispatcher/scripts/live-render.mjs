// ЖИВОЙ прогон визуала (T10): реальный Дизайнер через `claude -p`, реальные боты, реальные топики.
//
// ⚠ Скрипт ПИШЕТ В ГРУППУ и ТРАТИТ ВЫЗОВ CLAUDE. Запускать осознанно:
//   cd dispatcher && npm run live:t10 "сделай карусель про три ошибки в контенте"
//
// Что проверяет — весь срез тикета целиком:
//   задача → агент-Дизайнер (claude -p) → спецификация со слайдами → PNG в render/
//   → альбом в топик Дизайнера → тот же альбом + карточка в топик Издателя → элемент очереди.
//
// Чего он НЕ покрывает и покрыть не может: входящий хоп «человек пишет в топик Дизайнера»
// (бот не слышит бота — это проверяется руками в группе, как в T03) и нажатие кнопок карточки
// (callback приходит только от живого человека — проверяется руками, как в T07).

import { Bot } from 'grammy';
import { enabledIdentities } from '../src/bots/registry.js';
import { openDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { runAgent } from '../src/agent.js';
import { postToTopic } from '../src/bots/send.js';
import { enqueueAgentResult } from '../src/queue/approval.js';
import { findBrowser, NO_BROWSER_HINT } from '../../render/index.js';

const task = process.argv[2] || 'Сделай карусель на 5 слайдов про три ошибки, из-за которых контент не заходит.';

if (!config.forumGroupId) throw new Error('FORUM_GROUP_ID не задан в .env');
const browser = findBrowser();
if (!browser) throw new Error(NO_BROWSER_HINT);
console.log(`Браузер для рендера: ${browser}`);

// Поднимаем только тех, кто участвует: Дизайнер (автор и топик картинок) и Издатель (карточка).
const identities = enabledIdentities().filter((i) => i.key === 'designer' || i.key === 'publisher');
const designer = identities.find((i) => i.key === 'designer');
const publisher = identities.find((i) => i.key === 'publisher');
if (!designer) throw new Error('Дизайнер не поднят: нет BOT_TOKEN_DESIGNER в .env');
if (designer.topicId == null) throw new Error('TOPIC_DESIGNER не задан в .env — картинкам некуда идти');
if (!publisher) console.warn('⚠️ Издатель не поднят — карточки согласования не будет, только картинки.');

const botsByKey = new Map(identities.map((i) => [i.key, { identity: i, bot: new Bot(i.token) }]));
const db = openDb();

console.log(`\nЗадача Дизайнеру: ${task}`);
await postToTopic(botsByKey.get('designer').bot, config.forumGroupId, designer.topicId, `📌 Живая проверка T10\n\n${task}`);

console.log('Зову агента-Дизайнера через claude -p (это небыстро)…');
const res = await runAgent({ agentKey: 'designer', task });
if (!res.ok) {
  db.close();
  throw new Error(`агент не ответил: ${res.error}`);
}
console.log(`Агент ответил: kind=${res.meta?.kind} slides=${res.meta?.slides ?? '—'}`);

// Спецификацию показываем в топике — как это делает диспетчер в обычном режиме.
await postToTopic(botsByKey.get('designer').bot, config.forumGroupId, designer.topicId, res.content);

console.log('Рендерю и раскладываю по топикам…');
const queued = await enqueueAgentResult({
  db,
  agent: 'designer',
  meta: res.meta,
  content: res.content,
  botsByKey,
  groupId: config.forumGroupId,
});

console.log('\nрезультат:', {
  enqueued: queued.enqueued,
  id: queued.id,
  images: queued.images?.length ?? 0,
  note: queued.visualNote,
  cardError: queued.error ?? null,
  visualError: queued.visualError ?? null,
});

if (queued.id) {
  const item = db.queue.getById(queued.id);
  console.log(`в БД: #${item.id} status=${item.status} kind=${item.kind} картинок=${item.meta?.images?.length ?? 0}`);
  console.log(`файлы: ${item.meta?.render_dir ?? '—'}`);
}

db.close();
const ok = queued.enqueued && (queued.images?.length ?? 0) > 0;
console.log(ok ? '\n✓ живой рендер прошёл — смотри картинки в топиках Дизайнера и Издателя' : '\n✗ картинок нет — см. visualError выше');
