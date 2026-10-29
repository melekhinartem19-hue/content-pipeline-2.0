// Простой runner миграций: применяет неприменённые *.sql из db/migrations по порядку имён,
// каждую — в транзакции, и записывает применённые версии в таблицу schema_migrations.
//
// Абстракция: наружу знать про это не нужно — openDb() (см. index.js) вызывает migrate() при старте.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * @param {import('node:sqlite').DatabaseSync} db  открытое соединение (детали скрыты в index.js)
 * @returns {string[]} версии, применённые в этом вызове
 */
export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const justApplied = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
      db.exec('COMMIT');
      justApplied.push(version);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция ${file} упала: ${err.message}`);
    }
  }
  return justApplied;
}
