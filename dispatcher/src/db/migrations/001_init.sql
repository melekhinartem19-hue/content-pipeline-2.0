-- 001_init — базовая схема.
--
-- Заготовка под очередь согласования (наполнится в T07). Уже сейчас доказывает, что слой
-- доступа умеет писать/читать реальную таблицу.
--
-- ⚠ Диалект: часть синтаксиса ниже — SQLite-специфична. Что менять при переезде на Postgres:
--   • INTEGER PRIMARY KEY AUTOINCREMENT  → BIGSERIAL / GENERATED ALWAYS AS IDENTITY
--   • datetime('now')                    → now()  (или CURRENT_TIMESTAMP)
--   • TEXT под JSON (meta)               → jsonb
-- Точечная сводка точек переезда — в specs/db.md.

CREATE TABLE IF NOT EXISTS approval_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT    NOT NULL,                         -- 'tg' | 'ig' | 'threads'
  agent       TEXT    NOT NULL,                         -- ключ агента-автора (writer, designer, …)
  kind        TEXT    NOT NULL,                         -- 'tg_post' | 'carousel' | 'reels_script' | …
  title       TEXT,
  content     TEXT    NOT NULL,                         -- готовый к показу текст/черновик
  status      TEXT    NOT NULL DEFAULT 'draft',         -- draft | pending | approved | rejected | published
  meta        TEXT,                                     -- JSON-строка (доп. поля от агента)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON approval_queue(status);
