// Смоук-тест оркестрации Продюсера (T05): разбор tasks[], раздача по топикам, исполнение, статус.
// Всё оффлайн: вместо claude -p и Telegram — инъекции runner/poster. Запуск:
//   node dispatcher/scripts/smoke-orchestrator.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import {
  MAX_TASKS_PER_PLAN,
  dispatchPlan,
  extractTasks,
  isStatusCommand,
  renderDispatchSummary,
  renderStatus,
} from '../src/orchestrator.js';

// ── extractTasks: мусору из ответа модели не доверяем ──────────────────────
const known = ['writer', 'designer', 'scout'];
const parsed = extractTasks(
  {
    tasks: [
      { agent: 'Writer', brief: '  Три поста про тариф  ' }, // регистр и пробелы нормализуются
      { agent: 'video', brief: 'Смонтировать Reels' }, // нет такого бота → пропуск
      { agent: 'designer', brief: '   ' }, // пустое ТЗ → пропуск
      { brief: 'без агента' }, // нет agent → пропуск
    ],
  },
  known,
);
assert.deepEqual(parsed.tasks, [{ agent: 'writer', brief: 'Три поста про тариф' }], 'валидна одна задача');
assert.equal(parsed.skipped.length, 3, 'три задачи отсеяны с причинами');
assert.deepEqual(extractTasks({}, known).tasks, [], 'нет tasks[] → раздавать нечего');
assert.deepEqual(extractTasks({ tasks: 'нет' }, known).tasks, [], 'кривой tasks[] не роняет разбор');

const many = extractTasks({ tasks: Array.from({ length: 9 }, () => ({ agent: 'writer', brief: 'x' })) }, known);
assert.equal(many.tasks.length, MAX_TASKS_PER_PLAN, `план режется до ${MAX_TASKS_PER_PLAN} задач`);
assert.equal(many.skipped.length, 9 - MAX_TASKS_PER_PLAN, 'хвост отмечен как пропущенный');

// ── dispatchPlan: ТЗ в топик → исполнение → черновик в тот же топик ────────
const db = openDb(':memory:');
const posts = [];
const poster = async (bot, groupId, topicId, text) => {
  posts.push({ bot: bot?.name, groupId, topicId, text });
};
const botsByKey = new Map([
  ['producer', { bot: { name: 'producerBot' }, identity: { key: 'producer', agent: 'producer', topicId: 14 } }],
  ['writer', { bot: { name: 'writerBot' }, identity: { key: 'writer', agent: 'writer', topicId: 2 } }],
  ['designer', { bot: { name: 'designerBot' }, identity: { key: 'designer', agent: 'designer', topicId: 43 } }],
  // Разведчик поднят, но топик ему не задан — задача должна честно упасть, а не потеряться.
  ['scout', { bot: { name: 'scoutBot' }, identity: { key: 'scout', agent: 'scout', topicId: null } }],
]);

const runner = async ({ agentKey }) => {
  if (agentKey === 'designer') return { ok: false, error: 'claude -p: timeout' };
  return { ok: true, content: `Черновик от ${agentKey}` };
};

const results = await dispatchPlan({
  tasks: [
    { agent: 'writer', brief: 'Три поста про тариф' },
    { agent: 'designer', brief: 'Карусель 6 слайдов' },
    { agent: 'scout', brief: 'Собрать тренды' },
  ],
  goal: 'Неделя тарифа',
  db,
  groupId: -100123,
  botsByKey,
  poster,
  runner,
});

assert.deepEqual(
  results.map((r) => `${r.agent}:${r.status}`),
  ['writer:done', 'designer:failed', 'scout:failed'],
  'успех, падение агента и отсутствие топика различаются',
);

const writerPosts = posts.filter((p) => p.topicId === 2);
assert.equal(writerPosts.length, 2, 'в топик Сценариста ушли ТЗ и результат');
assert.equal(writerPosts[0].bot, 'producerBot', 'ТЗ постит Продюсер');
assert.match(writerPosts[0].text, /Задача #1 от Продюсера · Неделя тарифа/, 'в шапке ТЗ цель плана');
assert.equal(writerPosts[1].bot, 'writerBot', 'результат постит сам исполнитель');
assert.match(writerPosts[1].text, /Черновик от writer/, 'в топик ушёл контент агента');
assert.ok(!posts.some((p) => p.topicId === null), 'без топика в Telegram ничего не шлём');

const rows = db.tasks.list();
assert.equal(rows.length, 3, 'все три задачи записаны в БД');
assert.equal(db.tasks.getById(1).status, 'done', 'writer → done');
assert.match(db.tasks.getById(1).result, /Черновик от writer/, 'выжимка результата сохранена');
assert.match(db.tasks.getById(2).error, /timeout/, 'ошибка агента сохранена');
assert.match(db.tasks.getById(3).error, /TOPIC_SCOUT/, 'подсказка про незаданный топик');

// ── Сводка раздачи и команда статуса ───────────────────────────────────────
const summary = renderDispatchSummary(results, [{ agent: 'video', reason: 'нет такого агента' }]);
assert.match(summary, /#1 → writer/, 'в сводке есть успешная задача');
assert.match(summary, /пропущено → video/, 'в сводке есть пропуски');

const status = renderStatus(db);
assert.match(status, /done: 1/, 'в статусе видна сводка по состояниям');
assert.match(status, /#3 → scout/, 'в статусе перечислены задачи');
assert.match(renderStatus(openDb(':memory:')), /Задач пока нет/, 'пустая БД — понятный текст');

assert.ok(isStatusCommand('/статус'), 'слэш-команда распознаётся');
assert.ok(isStatusCommand('Статус'), 'слово без слэша тоже');
assert.ok(!isStatusCommand('статусы задач не нужны'), 'обычный текст не перехватывается');

db.close();
console.log('✓ smoke-orchestrator PASS — план Продюсера раздаётся, исполняется и виден в статусе');
