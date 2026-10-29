-- 008_funnel_manychat — что из воронки уже уехало в ManyChat (T14).
--
-- Ссылка на PDF живёт в двух местах: в статике (колонка url, её пишет T13) и в bot-поле ManyChat,
-- откуда её подставляет флоу в директе. Эти два места расходятся молча — например, клиент сменил
-- PUBLIC_BASE_URL и пересобрал PDF: в базе новая ссылка, а в ManyChat всё ещё старая, и люди
-- получают 404. Поэтому запоминаем, ЧТО и КОГДА мы записали в ManyChat, — и умеем показать
-- расхождение в «/воронка», не спрашивая ManyChat.
--
-- Отдельной таблицы не заводим: строка на тему уже есть, и синхронизация — свойство той же темы.

ALTER TABLE funnel_pdfs ADD COLUMN manychat_field TEXT;  -- имя bot-поля, куда записали (pdf_<ключ>)
ALTER TABLE funnel_pdfs ADD COLUMN manychat_url   TEXT;  -- значение, которое реально ушло в ManyChat
ALTER TABLE funnel_pdfs ADD COLUMN manychat_at    TEXT;  -- когда записали; NULL = ни разу
