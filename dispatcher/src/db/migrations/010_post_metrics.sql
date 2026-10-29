-- 010_post_metrics — снимки метрик опубликованного (T16, Аналитик).
--
-- ПО СНИМКУ НА ЗАМЕР, А НЕ ПО СТРОКЕ НА ПОСТ. Охваты и просмотры растут во времени: важна не
-- «последняя цифра», а как она менялась. Поэтому каждый замер — отдельная строка, а «сейчас» —
-- это просто последний снимок (см. analytics/report.js).
--
-- МЕТРИКИ ЛЕЖАТ JSON-ом. У площадок наборы разные и меняются вместе с версией Graph API: у Reels
-- одно, у карусели другое, у Threads третье. Прибивать их колонками — значит ловить миграцию на
-- каждое изменение Meta. Разбирать JSON умеет только Аналитик, остальным он не нужен.
--
-- Метрики собираются ТОЛЬКО по собственным аккаунтам клиента и только если он включил это
-- явно (ANALYTICS_INSIGHTS=1): инсайты требуют отдельных прав в Meta, а App Review мы не проходим
-- (правило 2 в CLAUDE.md). Без них Аналитик работает по фактам из своей базы — этого уже хватает.
--
-- ⚠ Диалект: datetime('now') → now() при переезде на Postgres. См. specs/db.md.

CREATE TABLE IF NOT EXISTS post_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id     INTEGER NOT NULL REFERENCES approval_queue(id), -- какой элемент очереди замеряли
  platform     TEXT NOT NULL,                                  -- tg | ig | threads
  ref          TEXT,                                           -- id поста на площадке (строкой, см. 006)
  metrics      TEXT NOT NULL,                                  -- JSON: { reach: 1200, likes: 43, … }
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- «Последний замер по посту» — самый частый запрос отчёта.
CREATE INDEX IF NOT EXISTS idx_post_metrics_queue ON post_metrics(queue_id, collected_at);
