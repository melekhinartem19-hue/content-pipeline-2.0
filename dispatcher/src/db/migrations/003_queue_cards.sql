-- 003_queue_cards — очередь согласования становится боевой (T07).
--
-- В 001 таблица approval_queue была заготовкой «текст + статус». Здесь добавляем всё, без чего
-- не живут карточка с кнопками и цикл правок:
--   • где висит карточка (card_chat_id/card_message_id) — чтобы после нажатия ОТРЕДАКТИРОВАТЬ её,
--     а не плодить новые сообщения; переживает перезапуск процесса, т.к. лежит в БД;
--   • откуда взялся черновик (task_id → tasks.id из T05);
--   • история правок (parent_id → предыдущая версия, edit_note → что попросили поправить);
--   • кто и когда решил (decided_by/decided_at);
--   • слот публикации (slot_at) — заготовка контент-календаря под T08.
--
-- Жизненный цикл status:
--   draft → pending → approved | rejected | needs_edit
--   needs_edit → (новая версия) → родитель становится superseded
--   approved → published (это уже T08)
--
-- ⚠ Диалект: ALTER TABLE ADD COLUMN с REFERENCES допустим в SQLite только при DEFAULT NULL.
-- При переезде на Postgres — обычные внешние ключи, datetime('now') → now(). См. specs/db.md.

ALTER TABLE approval_queue ADD COLUMN task_id         INTEGER REFERENCES tasks(id);
ALTER TABLE approval_queue ADD COLUMN parent_id       INTEGER REFERENCES approval_queue(id);
ALTER TABLE approval_queue ADD COLUMN card_chat_id    TEXT;
ALTER TABLE approval_queue ADD COLUMN card_message_id INTEGER;
ALTER TABLE approval_queue ADD COLUMN edit_note       TEXT;
ALTER TABLE approval_queue ADD COLUMN decided_by      TEXT;
ALTER TABLE approval_queue ADD COLUMN decided_at      TEXT;
ALTER TABLE approval_queue ADD COLUMN slot_at         TEXT;

-- Поиск карточки по сообщению, на котором нажали кнопку или которому ответили правкой.
CREATE INDEX IF NOT EXISTS idx_queue_card ON approval_queue(card_chat_id, card_message_id);
