// Смоук-тест репозитория задач (T05): постановка → running → done/failed → списки и сводка.
// Как и smoke-db, работает через слой доступа, без сырого SQL. Запуск: node dispatcher/scripts/smoke-tasks.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';

const db = openDb(':memory:');
assert.ok(db.appliedMigrations.includes('002_tasks'), 'миграция 002_tasks должна примениться');

const idW = db.tasks.add({ agent: 'writer', brief: 'Написать 3 поста про тариф', goal: 'Неделя тарифа', topicId: 2 });
const idD = db.tasks.add({ agent: 'designer', brief: 'Карусель 6 слайдов', goal: 'Неделя тарифа', topicId: 43 });
assert.ok(idW > 0 && idD > idW, 'add() возвращает растущие id');
assert.equal(db.tasks.getById(idW).status, 'queued', 'дефолтный статус — queued');
assert.equal(db.tasks.getById(idW).topic_id, 2, 'топик сохранён');

assert.equal(db.tasks.markRunning(idW), true, 'markRunning меняет строку');
assert.equal(db.tasks.getById(idW).status, 'running', 'статус running');

assert.equal(db.tasks.markDone(idW, 'Пост 1: …'), true, 'markDone меняет строку');
assert.equal(db.tasks.getById(idW).status, 'done', 'статус done');
assert.equal(db.tasks.getById(idW).result, 'Пост 1: …', 'выжимка результата сохранена');

db.tasks.markFailed(idD, 'claude -p: timeout');
assert.equal(db.tasks.getById(idD).status, 'failed', 'статус failed');
assert.match(db.tasks.getById(idD).error, /timeout/, 'текст ошибки сохранён');

assert.equal(db.tasks.list().length, 2, 'list без фильтра отдаёт обе задачи');
assert.equal(db.tasks.list()[0].id, idD, 'новые сверху');
assert.equal(db.tasks.list({ status: 'done' }).length, 1, 'list фильтрует по статусу');
assert.deepEqual(db.tasks.countsByStatus(), { done: 1, failed: 1 }, 'сводка по статусам');

assert.equal(db.tasks.markDone(9999, 'нет такой'), false, 'несуществующий id — false, не бросок');

db.close();
console.log('✓ smoke-tasks PASS — постановка задач и их статусы живут в БД');
