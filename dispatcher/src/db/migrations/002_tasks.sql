-- 002_tasks — задачи, которые Продюсер раздаёт другим агентам (T05).
--
-- Одна строка = одна задача из плана Продюсера (`tasks[]` в его META-конверте): кому, что,
-- в каком состоянии. На этой таблице держится команда «/статус» в топике Продюсера — сам агент
-- статусов не помнит (у него один проход без доступа к БД), помнит диспетчер.
--
-- Жизненный цикл status: queued → running → done | failed.
--   queued  — ТЗ разложено по топикам, исполнение ещё не начиналось;
--   running — идёт вызов агента-исполнителя (claude -p);
--   done    — исполнитель ответил, черновик отправлен в его топик;
--   failed  — вызов упал (текст ошибки в поле error).
--
-- ⚠ Диалект (то же, что в 001): AUTOINCREMENT и datetime('now') — SQLite-специфичны,
-- точки переезда на Postgres перечислены в specs/db.md.

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL,                        -- ключ агента-исполнителя (writer, designer, …)
  brief       TEXT    NOT NULL,                        -- ТЗ от Продюсера, как ушло в топик
  goal        TEXT,                                    -- цель плана (title из META Продюсера)
  status      TEXT    NOT NULL DEFAULT 'queued',       -- queued | running | done | failed
  topic_id    INTEGER,                                 -- топик, в который ушло ТЗ (null = топик не задан)
  result      TEXT,                                    -- краткая выжимка ответа исполнителя
  error       TEXT,                                    -- текст ошибки, если failed
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
