// Смоук-тест очереди согласования (T07): черновик → карточка → решение → правка → новая версия.
// Всё через слой доступа, без сырого SQL. Запуск: node dispatcher/scripts/smoke-queue.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';

const db = openDb(':memory:');
assert.ok(db.appliedMigrations.includes('003_queue_cards'), 'миграция 003_queue_cards должна примениться');

// ── Черновик от исполнителя ложится в очередь и связан с задачей Продюсера (T05) ──
const taskId = db.tasks.add({ agent: 'writer', brief: 'Пост про тариф', topicId: 2 });
const id = db.queue.add({
  platform: 'tg',
  agent: 'writer',
  kind: 'tg_post',
  title: 'Пост про тариф',
  content: '🚀 Запускаем новый тариф…',
  status: 'pending',
  taskId,
  meta: { brandFilled: 0 },
});
assert.equal(db.queue.getById(id).task_id, taskId, 'черновик помнит, из какой задачи он вырос');
assert.equal(db.queue.getById(id).status, 'pending', 'ждёт решения владельца');
assert.equal(db.queue.listPending().length, 1, 'элемент виден в списке ожидающих');

// ── Карточка: связь «сообщение в Telegram ↔ элемент очереди» живёт в БД ──
assert.equal(db.queue.attachCard(id, { chatId: -100123, messageId: 777 }), true, 'карточка привязана');
const byCard = db.queue.getByCard(-100123, 777);
assert.equal(byCard.id, id, 'элемент находится по сообщению-карточке');
assert.equal(db.queue.getByCard(-100123, 999), undefined, 'чужое сообщение ничего не находит');

// ── Решение владельца оставляет след ──
assert.equal(db.queue.decide(id, 'needs_edit', { by: 'owner', note: 'Убрать эмодзи' }), true, 'решение записано');
const decided = db.queue.getById(id);
assert.equal(decided.status, 'needs_edit', 'статус сменился');
assert.equal(decided.decided_by, 'owner', 'кто решил — сохранено');
assert.equal(decided.edit_note, 'Убрать эмодзи', 'текст правки сохранён');
assert.ok(decided.decided_at, 'время решения проставлено');

// ── Новая версия после правки: родитель уходит из очереди, история остаётся ──
const v2 = db.queue.add({
  platform: 'tg',
  agent: 'writer',
  kind: 'tg_post',
  title: 'Пост про тариф',
  content: 'Запускаем новый тариф…',
  status: 'pending',
  taskId,
  parentId: id,
  editNote: 'Убрать эмодзи',
});
db.queue.markSuperseded(id);
assert.equal(db.queue.getById(v2).parent_id, id, 'новая версия помнит предка');
assert.equal(db.queue.getById(id).status, 'superseded', 'старая версия ушла из очереди');
assert.equal(db.queue.listPending().length, 1, 'в ожидании ровно одна — новая версия');
assert.equal(db.queue.listPending()[0].id, v2, 'ждёт именно новая версия');

// ── Одобрение и слот календаря (заготовка под T08) ──
db.queue.decide(v2, 'approved', { by: 'owner' });
db.queue.setSlot(v2, '2026-09-05T10:00:00');
assert.equal(db.queue.getById(v2).status, 'approved', 'одобрено');
assert.equal(db.queue.getById(v2).slot_at, '2026-09-05T10:00:00', 'слот публикации сохранён');
assert.deepEqual(db.queue.countsByStatus(), { approved: 1, superseded: 1 }, 'сводка по статусам очереди');

// ── Переживание перезапуска: данные читаются из файла, а не из памяти процесса ──
// Файл кладём в системный temp, чтобы не мусорить в dispatcher/data.
const { rmSync } = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const file = path.join(os.tmpdir(), `smoke-queue-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
};
cleanup();

const first = openDb(file);
const persisted = first.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'До перезапуска', status: 'pending' });
first.queue.attachCard(persisted, { chatId: -100123, messageId: 42 });
first.close();

const second = openDb(file); // «перезапуск процесса»
const restored = second.queue.getByCard(-100123, 42);
assert.equal(restored.id, persisted, 'после перезапуска карточка по-прежнему находится');
assert.equal(restored.status, 'pending', 'статус пережил перезапуск');
second.queue.decide(persisted, 'approved', { by: 'owner' });
second.close();

const third = openDb(file); // и ещё один — решение тоже на диске
assert.equal(third.queue.getById(persisted).status, 'approved', 'решение тоже переживает перезапуск');
third.close();
cleanup();

db.close();
console.log('✓ smoke-queue PASS — очередь, карточки, правки и решения переживают перезапуск');
