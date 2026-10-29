-- 009_video_jobs — заявки на монтаж для ноутбука клиента (T16, автомонтаж).
--
-- ЗАЧЕМ ТАБЛИЦА, А НЕ ОЧЕРЕДЬ. В approval_queue лежит то, что публикуется. Заявка на монтаж —
-- это не контент и не черновик: публиковать её нельзя, согласовывать нечего, у неё своя жизнь
-- «одобренный сценарий → смонтировано → приехал ролик». Смешивать её со статусами очереди значило
-- бы ломать правило «одобренное публикуется» (см. queue/kinds.js).
--
-- ПОЧЕМУ PULL, А НЕ PUSH. Наружу VPS не открывает портов, а ноут включён не всегда: заявка ждёт
-- в базе, пока ноутбук сам не спросит «что монтировать» (video/pull-jobs.sh). Поэтому нужен
-- долгоживущий след в БД, а не сообщение, которое можно проспать.
--
-- Жизненный цикл status:
--   open → done      (ролик смонтирован и залит: result_queue_id ссылается на его карточку)
--   open → cancelled (передумали; заявка остаётся в истории)
--
-- ⚠ Диалект: datetime('now') → now() при переезде на Postgres. См. specs/db.md.

CREATE TABLE IF NOT EXISTS video_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id        INTEGER REFERENCES approval_queue(id), -- одобренный сценарий Reels, из которого выросла заявка
  title           TEXT,                                  -- тема: видно и в топике Видео, и на ноуте
  script          TEXT NOT NULL,                         -- сам сценарий: по нему и монтируют
  status          TEXT NOT NULL DEFAULT 'open',          -- open | done | cancelled
  result_queue_id INTEGER REFERENCES approval_queue(id), -- карточка готового ролика (T15)
  note            TEXT,                                  -- чем закончилось / почему отменили
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ноут спрашивает ровно одно: «что открыто».
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status, id);

-- Один одобренный сценарий = одна заявка: повторное нажатие «Одобрить» или перезапуск
-- планировщика не должны плодить дубли монтажа.
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_jobs_queue ON video_jobs(queue_id) WHERE queue_id IS NOT NULL;
