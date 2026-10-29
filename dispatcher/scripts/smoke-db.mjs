// Смоук-тест слоя БД (T02): запись → чтение → смена статуса через слой доступа (без сырого SQL).
// Запуск: node dispatcher/scripts/smoke-db.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';

const db = openDb(':memory:'); // in-memory: тест не трогает реальный файл
assert.ok(db.appliedMigrations.includes('001_init'), 'миграция 001_init должна примениться');

const id = db.queue.add({
  platform: 'tg',
  agent: 'writer',
  kind: 'tg_post',
  title: 'Тест',
  content: 'Привет из смоук-теста',
  meta: { topic: 'запуск' },
});
assert.ok(id > 0, 'add() должен вернуть id');

const row = db.queue.getById(id);
assert.equal(row.content, 'Привет из смоук-теста', 'контент читается обратно');
assert.equal(row.meta.topic, 'запуск', 'meta разворачивается из JSON');
assert.equal(row.status, 'draft', 'дефолтный статус — draft');

assert.equal(db.queue.setStatus(id, 'approved'), true, 'setStatus меняет строку');
assert.equal(db.queue.getById(id).status, 'approved', 'статус обновился');

assert.equal(db.queue.list({ status: 'approved' }).length, 1, 'list фильтрует по статусу');
assert.equal(db.queue.list({ status: 'draft' }).length, 0, 'draft-записей не осталось');

db.close();
console.log('✓ smoke-db PASS — запись/чтение/статус через слой доступа работают');
