-- 005_trends — след сбора трендов (T09).
--
-- Три таблицы, каждая отвечает на свой вопрос:
--   trend_runs   — «когда и чем собирали, чем кончилось». На ней держится лимит «1 прогон/день»:
--                  без БД лимит бы обнулялся при каждом перезапуске процесса.
--   trend_posts  — «что уже видели». Ссылка UNIQUE — это и есть дедуп: один и тот же пост не
--                  уходит Разведчику дважды и не тратит вызов claude -p повторно.
--   trend_topics — «какие темы получились». Из них Продюсер/Сценарист берут материал для постов.
--
-- Статусы прогона: running → ok | empty | failed | skipped.
--   running — идёт сбор;                    ok      — собрали и разобрали;
--   empty   — нового ничего не нашлось;      failed  — актор или агент упали (причина в note);
--   skipped — лимит суток не дал запуститься (прогон записан, чтобы это было видно).
--
-- ⚠ Диалект: AUTOINCREMENT и datetime('now') — SQLite-специфичны, см. specs/db.md.

CREATE TABLE IF NOT EXISTS trend_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT    NOT NULL,                        -- YYYY-MM-DD локальной даты (лимит прогонов в сутки)
  provider     TEXT    NOT NULL,                        -- apify | login (вариант C, резерв)
  status       TEXT    NOT NULL DEFAULT 'running',      -- running | ok | empty | failed | skipped
  posts_found  INTEGER NOT NULL DEFAULT 0,              -- сколько постов вернул сбор
  posts_new    INTEGER NOT NULL DEFAULT 0,              -- сколько из них новых (после дедупа)
  topics_found INTEGER NOT NULL DEFAULT 0,              -- сколько тем выделил Разведчик
  note         TEXT,                                    -- заметки прогона / причина ошибки
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_trend_runs_day ON trend_runs(day, status);

CREATE TABLE IF NOT EXISTS trend_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER REFERENCES trend_runs(id),
  platform     TEXT    NOT NULL,                        -- ig | threads
  url          TEXT    NOT NULL UNIQUE,                 -- дедуп: тот же пост второй раз не запишется
  author       TEXT,
  text         TEXT,
  likes        INTEGER,
  comments     INTEGER,
  views        INTEGER,
  posted_at    TEXT,                                    -- YYYY-MM-DD, как отдал актор
  source_query TEXT,                                    -- откуда взят: @аккаунт или #хэштег
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trend_posts_run ON trend_posts(run_id);

CREATE TABLE IF NOT EXISTS trend_topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER REFERENCES trend_runs(id),
  topic      TEXT    NOT NULL,                          -- название темы из отчёта Разведчика
  why        TEXT,                                      -- «почему заходит»
  angle      TEXT,                                      -- «угол» — зацепка для Сценариста
  used       INTEGER NOT NULL DEFAULT 0,                -- 1 = по теме уже писали пост
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trend_topics_used ON trend_topics(used);
