# Установка на VPS: с нуля до «боты отвечают в топиках»

Debian 12 или Ubuntu 22.04+, 2 ГБ RAM, root или sudo. Всё выполняется **один раз**, на сервере
клиента, на его аккаунтах. Дальше система живёт сама.

Проверка после каждого шага — в конце шага. Не переходить дальше, пока проверка не прошла: почти
все проблемы установки ловятся на своём шаге, а не в конце.

---

## 1. Система и Node 24

**Нужен именно Node 24+.** Слой БД работает на встроенном `node:sqlite`: он появился в Node 22.5 и
до Node 24 требует флаг `--experimental-sqlite`, которого в скриптах нет. На Node 20 из системного
репозитория продукт не стартует вообще.

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates git

# Node 24 из NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v      # должно быть v24.x или новее
```

**Часовой пояс — сразу, до всего остального.** Свежий VPS почти всегда стоит в UTC, а всё
расписание системы считается по **локальному времени сервера**: `TRENDS_AT`, `ANALYTICS_AT`,
слоты контент-календаря и даже граница суток у лимита «1 прогон трендов в день». В UTC на
московском клиенте `TRENDS_AT=09:00` сработает в 12:00, а еженедельный отчёт может уехать на
соседний день недели.

```bash
timedatectl                                      # что стоит сейчас
sudo timedatectl set-timezone Europe/Moscow      # часовой пояс клиента, а не свой
```

Менять пояс на работающей системе можно, но после смены — рестарт сервиса, иначе процесс
продолжит жить со старым временем.

## 2. Браузер и кириллические шрифты

Браузер нужен для каруселей, обложек и PDF-лид-магнитов (модуль `render/`). **Шрифты обязательны:
без них кириллица на слайдах превратится в квадратики** — шрифт не встраивается, берётся системный.

```bash
sudo apt-get install -y fonts-dejavu fonts-noto-core
```

Дальше — браузер, и здесь дистрибутивы расходятся:

```bash
# Debian 12 — обычный пакет, живёт в /usr/bin/chromium
sudo apt-get install -y chromium

# Ubuntu — пакет chromium там переходный, тянет snap-версию; под systemd это лишняя морока.
# Проще поставить браузер playwright'ом (ляжет в ~/.cache/ms-playwright, модуль render его найдёт):
npx playwright install --with-deps chromium
```

Искать браузер не нужно: `render/browser.js` сам проверяет `/usr/bin/chromium`, системный Chrome и
кэш playwright. Явный путь задаётся `RENDER_BROWSER=/полный/путь` в `.env` — только если браузеров
несколько или лежит нестандартно.

**Проверка:** `chromium --version` (или `ls ~/.cache/ms-playwright`) отвечает без ошибки.

## 3. Пользователь и код

Отдельный пользователь без sudo: диспетчер не должен ходить по системе.

```bash
sudo adduser --system --group --home /opt/content-pipeline pipeline
```

Дальше — положить папку проекта в `/opt/content-pipeline`. Репозиторий передаётся **папкой**
(архив, `rsync`, флешка — как удобно), git для работы не нужен.

```bash
# со своей машины:
rsync -av --exclude node_modules --exclude .env --exclude 'dispatcher/data' \
      ./content-pipeline/ root@СЕРВЕР:/opt/content-pipeline/

sudo chown -R pipeline:pipeline /opt/content-pipeline
```

**Что НЕ копировать:** `dispatcher/.env` (там твои токены — на сервере заполняется заново),
`dispatcher/data/` (тестовая база: на VPS она создастся с нуля миграциями), `node_modules/`.

**Обновление уже работающего сервера** — тот же `rsync`, но обязательно с `--exclude 'brand-brain/'`:
на сервере в `brand-brain/` уже слоты клиента, «Входящие» и присланные боту «Мозг бренда» файлы, а
у тебя — пустые шаблоны. Без исключения `rsync` молча перезапишет их шаблонами. Новый слот
`09-inbox.md` на сервер класть не нужно: бот создаст его сам при первой записи.

## 4. Зависимости — установок ДВЕ

Диспетчер и рендер — отдельные npm-модули: у рендера тяжёлая зависимость (браузерный клиент), и
это сделано нарочно.

```bash
sudo -u pipeline bash -lc 'cd /opt/content-pipeline/dispatcher && npm install --omit=dev'
sudo -u pipeline bash -lc 'cd /opt/content-pipeline/render && npm install --omit=dev'
```

`playwright-core` браузер не качает — он берёт тот, что поставлен на шаге 2.

## 5. Claude Code на сервере

**Весь интеллект системы идёт через `claude -p` на подписке клиента** (правило 1 `CLAUDE.md`):
Node никогда не ходит в Anthropic API напрямую. Значит, Claude Code должен быть установлен и
залогинен **на самом VPS**, под тем же пользователем, от которого работает диспетчер.

```bash
sudo npm install -g @anthropic-ai/claude-code
sudo -u pipeline bash -lc 'cd /opt/content-pipeline && claude'    # интерактивный вход
```

Вход интерактивный и делается **под аккаунтом клиента**: CLI покажет ссылку, её нужно открыть в
браузере (можно на телефоне) и вернуть код. Это единственный шаг установки, который нельзя
сделать за клиента заранее.

**Проверка — самая важная во всей установке:**

```bash
sudo -u pipeline bash -lc 'claude -p "ответь одним словом: ок"'
```

Пока эта команда не отвечает, ни один агент работать не будет — ни тексты, ни тренды, ни PDF.

## 6. Переменные окружения

```bash
sudo -u pipeline bash -lc 'cd /opt/content-pipeline/dispatcher && cp .env.example .env'
sudo -u pipeline nano /opt/content-pipeline/dispatcher/.env
```

[`.env.example`](../dispatcher/.env.example) написан как чек-лист: у каждой переменной сказано,
откуда её взять и что сломается без неё. Минимум, чтобы система вообще поднялась:

- `BOT_TOKEN_*` — все шесть токенов, `FORUM_GROUP_ID`, `TOPIC_*` — все шесть топиков;
- `OWNER_IDS` — user_id владельца и клиента через запятую. Пусто = боты отвечают любому, кто нашёл
  бота в поиске Telegram, и каждый чужой запрос тратит Pro-подписку клиента. Если id ещё неизвестны:
  оставить пустым, запустить, написать боту в личку — в логе появится строка `[access]` с нужным id;
- `TG_CHANNEL_ID` — канал клиента, бот Издателя обязан быть его админом с правом публикации;
- `PUBLIC_DIR=/var/www/content-pipeline` и `PUBLIC_BASE_URL=https://media.домен-клиента` — без них
  не будет ни IG-каруселей, ни ссылок на PDF в воронке.

Остальное (`APIFY_TOKEN`, `IG_*`, `THREADS_*`, `MANYCHAT_TOKEN`) можно дозаполнять по мере
получения доступов: без них не работает соответствующая площадка, но система живёт.

**Секреты только здесь.** `.env` в git не коммитится; тексты и настройки, не являющиеся секретами
(`trends/sources.json`, `manychat/funnel.json`), лежат видимыми файлами в репозитории.

```bash
sudo -u pipeline bash -lc 'cd /opt/content-pipeline && cp trends/sources.example.json trends/sources.json'
sudo -u pipeline bash -lc 'cd /opt/content-pipeline && cp manychat/funnel.example.json manychat/funnel.json'
```

## 7. Публичная папка

```bash
sudo mkdir -p /var/www/content-pipeline
sudo chown pipeline:pipeline /var/www/content-pipeline
```

Раздаёт её Nginx — конфиг и HTTPS в [nginx/](nginx/).

## 8. Первый запуск

> **Сначала погасить диспетчер на своей машине.** Если стенд до этого крутился локально, токены
> те же — а Telegram отдаёт обновления по токену **ровно одному** long-polling-потоку. Два
> запущенных диспетчера начнут выдирать сообщения друг у друга, в логах пойдёт
> `409: Conflict: terminated by other getUpdates request`, и половина задач будет молча теряться.
> Диагностируется плохо: боты «через раз не отвечают». Локальный `npm run dev` / `npm start` —
> остановить до старта на VPS.

Миграции базы применяются сами при старте — отдельной команды нет.

```bash
# оффлайн-самопроверка всей установки: БД, рендер, PDF, публикация, тренды, воронка
sudo -u pipeline bash -lc 'cd /opt/content-pipeline/dispatcher && npm run smoke'

# предполётная проверка публикации: токены IG/Threads, права, публичная статика.
# НИЧЕГО не публикует — можно гонять сколько угодно раз, правя .env между прогонами.
sudo -u pipeline bash -lc 'cd /opt/content-pipeline/dispatcher && npm run check:meta'

# запуск в консоли, чтобы видеть лог
sudo -u pipeline bash -lc 'cd /opt/content-pipeline/dispatcher && npm start'
```

`npm run smoke` — 24 проверки, они не тратят ни вызовов Claude, ни денег: если зелено, значит
Node, браузер, шрифты, БД и все модули на месте.

**Проверка:** написать в топик Сценариста в форум-группе любую задачу — бот отвечает готовым
текстом. Если ответа нет, смотреть лог: чаще всего это неверный `TOPIC_*` (бот игнорирует чужие
топики молча — так и задумано) или незалогиненный `claude` из шага 5.

Как узнать `TOPIC_*`, если группа новая: поднять с `DEBUG_IDS=1` и написать в каждый топик слово с
именем агента — в лог напечатается `thread=` и текст. Метода «перечислить топики форума» в Bot API
нет, это единственный способ.

## 9. Автозапуск

Когда всё отвечает — перевести на systemd: [systemd/](systemd/).
