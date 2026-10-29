-- 004_publish — след публикации (T08).
--
-- До этого очередь заканчивалась решением владельца. Теперь у элемента есть жизнь после «Одобрить»:
--   • published_message_id — id сообщения в канале (по нему потом можно найти/удалить/собрать метрику);
--   • published_at         — когда ушло;
--   • publish_error        — почему не ушло (бот не админ канала, канал не задан, сеть).
--
-- Статусы после 003 дополняются:
--   approved → published            (публикуем сразу по «Одобрить»)
--   approved → scheduled → published (если у элемента задан слот на будущее)
--   approved → publish_failed        (ошибка отправки; видно в /очередь, можно повторить)
--
-- ⚠ Диалект: datetime('now') → now() при переезде на Postgres. См. specs/db.md.

ALTER TABLE approval_queue ADD COLUMN published_message_id INTEGER;
ALTER TABLE approval_queue ADD COLUMN published_at         TEXT;
ALTER TABLE approval_queue ADD COLUMN publish_error        TEXT;

-- Планировщику нужно быстро находить «что пора публиковать».
CREATE INDEX IF NOT EXISTS idx_queue_slot ON approval_queue(status, slot_at);
