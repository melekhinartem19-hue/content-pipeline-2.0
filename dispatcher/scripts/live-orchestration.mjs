// ЖИВОЙ прогон оркестрации Продюсера (T05) — в отличие от smoke-*, тут всё настоящее:
// реальные бот-токены из .env, реальные топики форум-группы и реальные вызовы `claude -p`.
//
// ⚠ Скрипт ПИШЕТ СООБЩЕНИЯ В ГРУППУ и тратит вызовы Claude Code. Запускать осознанно:
//   cd dispatcher && node --env-file=.env scripts/live-orchestration.mjs "нужен 1 пост про X"
//
// Что проверяет: план Продюсера → раздача ТЗ по топикам → исполнение агентами → черновики в
// топиках → статусы в БД. Входящий хоп (человек пишет в топик → роутер) здесь не участвует: он
// проверен вживую в T03, а бот сообщения другого бота всё равно не получает.

import { Bot } from 'grammy';
import { enabledIdentities } from '../src/bots/registry.js';
import { postToTopic } from '../src/bots/send.js';
import { runAgent } from '../src/agent.js';
import { openDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { dispatchPlan, extractTasks, renderDispatchSummary, renderStatus } from '../src/orchestrator.js';

const PRODUCER_KEY = 'producer';
const task = process.argv[2] || 'Нужен 1 короткий пост в Telegram про запуск нового тарифа, к пятнице.';

const identities = enabledIdentities();
if (!config.forumGroupId) throw new Error('FORUM_GROUP_ID не задан в .env');

// Боты создаются БЕЗ start(): нам нужен только исходящий api.sendMessage, long polling не трогаем,
// чтобы не конфликтовать с параллельно запущенным `npm run dev`.
const botsByKey = new Map(
  identities.map((identity) => [identity.key, { identity, bot: new Bot(identity.token) }]),
);
const producer = botsByKey.get(PRODUCER_KEY);
if (!producer) throw new Error('Продюсер не поднят: нет BOT_TOKEN_PRODUCER в .env');

const db = openDb();
console.log(`Задача Продюсеру: ${task}`);
console.log('→ зову агента producer через claude -p …');

const plan = await runAgent({ agentKey: PRODUCER_KEY, task });
if (!plan.ok) throw new Error(`агент producer упал: ${plan.error}`);
console.log(`\n─── ПЛАН ПРОДЮСЕРА ───\n${plan.content}\n─── META ───\n${JSON.stringify(plan.meta)}\n`);

// План — в топик Продюсера, как это делает бот в ответ на сообщение владельца.
await postToTopic(producer.bot, config.forumGroupId, producer.identity.topicId, plan.content);

const executors = [...botsByKey.values()]
  .filter((e) => e.identity.agent && e.identity.key !== PRODUCER_KEY)
  .map((e) => e.identity.key);
const { tasks, skipped } = extractTasks(plan.meta, executors);
console.log(`Задач к раздаче: ${tasks.length} (${tasks.map((t) => t.agent).join(', ') || '—'}), пропущено: ${skipped.length}`);

if (tasks.length) {
  await postToTopic(producer.bot, config.forumGroupId, producer.identity.topicId, `📤 Раздаю задач: ${tasks.length}. Исполняю по очереди…`);
}

const results = await dispatchPlan({
  tasks,
  goal: typeof plan.meta?.title === 'string' ? plan.meta.title : null,
  db,
  groupId: config.forumGroupId,
  botsByKey,
  producerKey: PRODUCER_KEY,
});

const summary = renderDispatchSummary(results, skipped);
if (summary) {
  console.log(`\n${summary}`);
  await postToTopic(producer.bot, config.forumGroupId, producer.identity.topicId, summary);
}

// Так же, как ответит команда «/статус» в топике Продюсера.
const status = renderStatus(db);
console.log(`\n${status}`);
await postToTopic(producer.bot, config.forumGroupId, producer.identity.topicId, status);

db.close();
console.log('\n✓ живой прогон завершён — смотри группу');
