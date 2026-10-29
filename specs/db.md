# Spec: Слой доступа к БД — T02

Абстрагированный слой доступа к данным. Вызывающий код **не пишет сырой SQL** и не импортирует
драйвер — только методы репозиториев. Это позволяет позже переехать на Postgres, не трогая
вызывающих.

## Что используется
- **node:sqlite** (встроенный в Node ≥ 22, стабильно работает на Node 24) — ноль нативных
  зависимостей, идеально для хендовера (клиенту нечего собирать).
- Драйвер спрятан внутри [../dispatcher/src/db/index.js](../dispatcher/src/db/index.js).

## Компоненты
| Файл | Роль |
|---|---|
| [src/db/index.js](../dispatcher/src/db/index.js) | `openDb()` + фасад с репозиториями. ЕДИНСТВЕННОЕ место с `node:sqlite` |
| [src/db/migrate.js](../dispatcher/src/db/migrate.js) | Runner миграций: применяет неприменённые `*.sql`, трекает в `schema_migrations` |
| [src/db/migrations/001_init.sql](../dispatcher/src/db/migrations/001_init.sql) | Первая схема: таблица `approval_queue` (заготовка под T07) |

## API слоя (пример)
```js
import { openDb } from './src/db/index.js';
const db = openDb();                 // путь из DB_PATH; применяет миграции при старте
const id = db.queue.add({ platform:'tg', agent:'writer', kind:'tg_post', content:'...', meta:{...} });
db.queue.getById(id);                // meta разворачивается из JSON в объект
db.queue.list({ status:'draft' });
db.queue.setStatus(id, 'approved');
db.close();
```
Никаких `SELECT`/`INSERT` у вызывающих — только методы `db.queue.*`.

## Миграции
При `openDb()` вызывается `migrate()`: создаёт `schema_migrations`, применяет новые файлы по
порядку имён, каждый в транзакции. Новая миграция = новый файл `NNN_name.sql` (не менять старые).

## Переезд на Postgres (что менять)
1. **[src/db/index.js](../dispatcher/src/db/index.js)** — заменить `node:sqlite` на pg-драйвер,
   переписать тела методов репозиториев (интерфейс наружу оставить тем же).
2. **[src/db/migrate.js](../dispatcher/src/db/migrate.js)** — исполнение SQL через pg; логика та же.
3. **Диалект в миграциях**: `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL`/IDENTITY;
   `datetime('now')` → `now()`; `TEXT` под JSON (`meta`) → `jsonb`.
Вызывающий код (`db.queue.*`) не меняется — в этом и смысл слоя.

## Проверка
`node scripts/smoke-db.mjs` — запись → чтение → смена статуса через слой (in-memory БД).
