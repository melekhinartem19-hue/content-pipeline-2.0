# Spec: Диспетчер (спайн) — T01

Node-диспетчер = «тупая труба»: принимает Telegram-сообщение → зовёт Claude Code подпроцессом
(`claude -p`) → возвращает ответ в тот же чат. Интеллекта в Node нет.

## Главное правило
Node **никогда** не ходит в Anthropic API напрямую. Единственная точка «интеллекта» —
[../dispatcher/src/claude.js](../dispatcher/src/claude.js), и она делает только `spawn('claude', ['-p'])`.
Прямых HTTP-запросов к API в коде нет (проверяемо grep’ом по `api.anthropic`).

## Компоненты
| Файл | Роль |
|---|---|
| [src/claude.js](../dispatcher/src/claude.js) | Враппер `claude -p`: промпт через stdin, тайм-аут, обработка stderr/кода/ошибки spawn |
| [src/config.js](../dispatcher/src/config.js) | Чтение `.env` и путей репозитория |
| [src/bots/registry.js](../dispatcher/src/bots/registry.js) | Реестр бот-идентичностей (сейчас 1 спайн-бот; расширяется в T03) |
| [src/index.js](../dispatcher/src/index.js) | Поднимает ботов (grammY, long polling), обработчик текста, нарезка ответа под лимит 4096 |
| [src/orchestrator.js](../dispatcher/src/orchestrator.js) | Раздача и исполнение задач Продюсера, `/статус` (T05, см. producer-orchestration.md) |

## Поток одного сообщения
1. grammY ловит `message:text`.
2. `produceReply`: если у идентичности задан `agent` — идём по контракту (см. agent-contract.md);
   иначе (спайн) — сырой прогон текста через `runClaude`.
3. Ответ режется по 4096 символов и уходит обратно отправителю.
4. Ошибки логируются, пользователю — короткое «внутренняя ошибка».

## Кросс-платформенность
`claude.js` на Windows запускает «голую» команду `claude` через shell (резолв `.cmd`-шима),
на Linux/VPS — без shell. Пути с разделителями всегда без shell (иначе ломаются пробелы).

## Тайм-аут и ошибки
`CLAUDE_TIMEOUT_MS` (default 120000). По тайм-ауту подпроцесс убивается, возвращается
`{ ok:false, timedOut:true }`. Ненулевой код → `{ ok:false, error:<stderr> }`.

На Windows под `shell:true` убить надо **всё дерево** (`taskkill /T /F`): обычный kill валит только
`cmd.exe`, а внуки (`claude` → `node`) остаются висеть и копятся.

## Гоча Windows: `exit code 3221225794` (0xC0000142)
Прилетало вживую. Это `STATUS_DLL_INIT_FAILED` — подпроцесс **не стартовал**, потому что на машине
уже висел десяток `claude.exe`/`node.exe`/`cmd.exe` (каждый вызов на Windows = `cmd.exe` → шим
`claude.cmd` → `node`). Не ошибка агента и не наша логика — нехватка ресурсов.

Что сделано: `runClaude` распознаёт транзиентные коды старта (`0xC0000142`, `0xC0000017`) и
**повторяет запуск до 3 раз** с нарастающей паузой; если не помогло — в ошибке прямо сказано, что
надо закрыть лишние процессы. Обычные ошибки агента (код 1) повторами не размазываются.
Одиночный прогон доступен как `runClaudeOnce`.

## Как запустить
```
cp dispatcher/.env.example dispatcher/.env   # вписать TELEGRAM_BOT_TOKEN тестового бота
cd dispatcher && npm run dev                 # бот на long polling
```

## Проверка (без секретов)
`node scripts/smoke-claude.mjs` — механика подпроцесса (успех/ошибка/тайм-аут) на node-заглушке.
Реальный прогон: `node -e "import('./src/claude.js')..."` → `claude -p` отвечает.

## Границы / дальше
- 6 ботов + роутер форум-группы — T03, отдельный план [bots-rollout-plan.md](bots-rollout-plan.md).
- Очередь согласования и кнопки — T07 (заготовка таблицы уже в БД, см. db.md).
