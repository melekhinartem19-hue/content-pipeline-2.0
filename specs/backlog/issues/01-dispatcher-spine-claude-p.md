# 01 — Спайн диспетчера: 1 бот + `claude -p`

**What to build:** Один Telegram-бот принимает входящее сообщение, диспетчер («тупая труба») вызывает Claude Code подпроцессом (`claude -p "..."`) на Pro-подписке клиента и возвращает ответ в тот же чат. Это доказывает главный хребет всей системы: интеллект — только через подписочный CC, Node никогда не ходит в Anthropic API напрямую.

**Blocked by:** None — can start immediately.

**Status:** done — spec: [../../dispatcher.md](../../dispatcher.md)

- [x] `.env` с токеном тестового бота, секреты не в git (`.env.example`, `.gitignore`)
- [x] Бот запускается локально и получает сообщения (grammY long polling)
- [x] Диспетчер зовёт `claude -p` подпроцессом (stdin), ловит stdout/stderr, тайм-аут и ошибки spawn — `src/claude.js`
- [x] Ответ CC уходит обратно в чат отправителю (нарезка под лимит 4096)
- [x] Нигде нет прямого HTTP-вызова Anthropic API (проверено grep’ом)
- [x] Короткий spec модуля диспетчера положен в `specs/dispatcher.md`
