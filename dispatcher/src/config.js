// Конфиг диспетчера: единая точка чтения окружения и путей репозитория.
// Секреты приходят только из .env (см. dispatcher/.env.example), в git не коммитятся.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOwnerIds } from './bots/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Корень репозитория content-pipeline (из dispatcher/src → на два уровня вверх).
export const ROOT = path.resolve(__dirname, '..', '..');
export const DISPATCHER_DIR = path.resolve(__dirname, '..');
export const AGENTS_DIR = path.join(ROOT, 'agents');
export const BRAND_BRAIN_DIR = path.join(ROOT, 'brand-brain');

export const config = {
  // ── Claude Code (единственный источник «интеллекта») ──────────────────
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 120_000),

  // ── SQLite (слой доступа абстрагирован, см. src/db) ───────────────────
  dbPath: process.env.DB_PATH || path.join(DISPATCHER_DIR, 'data', 'pipeline.sqlite'),

  // ── Telegram ──────────────────────────────────────────────────────────
  // ID общей форум-группы (для T03; на спайне T01 не обязателен).
  forumGroupId: process.env.FORUM_GROUP_ID || null,

  // Канал клиента, куда публикуется одобренный TG-контент (T08). Может быть id (-100…) или @username.
  // Бот Издателя обязан быть админом этого канала с правом публикации.
  tgChannelId: process.env.TG_CHANNEL_ID || null,

  // Allowlist владельцев: чьи сообщения и нажатия бот вообще обрабатывает (user_id через запятую).
  // ПУСТО = фильтр выключен, отвечаем всем — так работает локальная отладка и первый запуск, пока
  // id ещё неизвестны. На боевом сервере заполняется обязательно: каждое сообщение постороннего
  // уходит в claude -p на Pro-подписку клиента. Свой id клиент узнаёт, написав боту в личку:
  // отказ печатается в лог с user_id (см. src/index.js).
  ownerIds: parseOwnerIds(process.env.OWNER_IDS),

  // ── T10: рендер каруселей и обложек ───────────────────────────────────
  // Куда складываются отрендеренные PNG (по папке на прогон). Рядом с БД, в git не коммитится.
  rendersDir: process.env.RENDERS_DIR || path.join(DISPATCHER_DIR, 'data', 'renders'),

  // Каталог «мозга бренда» — из него рендер берёт цвета, шрифт и подпись (08-visual-style.md).
  // Отдельным полем, чтобы модуль render/ получал путь, а не лез в структуру репозитория сам.
  brandBrainDir: BRAND_BRAIN_DIR,

  // ── T13: PDF-лид-магниты инста-воронки ────────────────────────────────
  // Три фиксированные темы. Файл вне dispatcher/ — это данные клиента, а не код (как и источники
  // трендов): менять темы можно, не трогая репозиторий кода. См. manychat/README.md.
  funnelConfigPath: process.env.FUNNEL_CONFIG || path.join(ROOT, 'manychat', 'funnel.json'),

  // Куда складываются собранные PDF (по файлу на тему, имя = ключ темы). Рядом с БД, в git не идёт.
  // Наружу их отдаёт не эта папка, а публичная статика (PUBLIC_DIR/PUBLIC_BASE_URL ниже).
  pdfsDir: process.env.PDFS_DIR || path.join(DISPATCHER_DIR, 'data', 'pdf'),

  // Подпапка внутри публичной статики, куда копируются PDF воронки. Меняется редко: адрес
  // попадает в ManyChat, и после запуска воронки его смена ломает уже разосланные ссылки.
  pdfPublicSubdir: process.env.PDF_PUBLIC_SUBDIR || 'funnel',

  // ── T14: инста-воронка в ManyChat ─────────────────────────────────────
  // Диспетчер записывает три ссылки на PDF в bot-поля ManyChat, а флоу с кнопками собирает
  // человек в UI: API ManyChat умеет только поля. Ключ — аккаунта КЛИЕНТА (Settings → API).
  manychatToken: process.env.MANYCHAT_TOKEN || null,
  manychatApiUrl: process.env.MANYCHAT_API_URL || 'https://api.manychat.com',

  // Префикс имён bot-полей: pdf_content_plan, pdf_reels_hooks, … Менять после настройки флоу
  // нельзя — во флоу останутся ссылки на старые имена полей, и директ отдаст пустоту.
  manychatFieldPrefix: process.env.MANYCHAT_FIELD_PREFIX || 'pdf_',

  // Сухой прогон: запросы в ManyChat не уходят, а печатаются планом в топик Презентатора.
  manychatDryRun: process.env.MANYCHAT_DRY_RUN === '1',

  // ── T11/T12: публикация в Threads и Instagram (Graph API, dev-mode) ───
  // App Review не проходим (CLAUDE.md, правило 2): приложение клиента, клиент админ/тестер,
  // публикация только в его собственные аккаунты. Все креды вводит КЛИЕНТ при установке.
  metaGraphVersion: process.env.META_GRAPH_VERSION || 'v21.0',

  // Приложение Meta — ТОЛЬКО для предполётной проверки («/проверка», npm run check:meta): по ним
  // Meta отдаёт срок жизни токена и его права. Публикации не нужны, поэтому необязательные.
  metaAppId: process.env.META_APP_ID || null,
  metaAppSecret: process.env.META_APP_SECRET || null,

  // Instagram: свой хост, свой аккаунт-id и свой токен.
  igGraphBaseUrl: process.env.IG_GRAPH_BASE_URL || 'https://graph.facebook.com',
  igUserId: process.env.IG_USER_ID || null,
  igAccessToken: process.env.IG_ACCESS_TOKEN || null,

  // Threads: ОТДЕЛЬНЫЙ API и отдельный токен — не тот же, что у Instagram.
  threadsGraphBaseUrl: process.env.THREADS_GRAPH_BASE_URL || 'https://graph.threads.net',
  threadsUserId: process.env.THREADS_USER_ID || null,
  threadsAccessToken: process.env.THREADS_ACCESS_TOKEN || null,

  // Instagram скачивает медиа сам, поэтому кадры из T10 должны стать публичными ссылками:
  // publicDir — папка, которую раздаёт Nginx, publicBaseUrl — её адрес снаружи.
  publicDir: process.env.PUBLIC_DIR || null,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || null,

  // Сухой прогон: вызовы Meta не уходят, а печатаются планом. Статус элемента не меняется.
  publishDryRun: process.env.PUBLISH_DRY_RUN === '1',

  // Ожидание обработки видео для Reels: Meta принимает ролик, обрабатывает его асинхронно и только
  // после FINISHED даёт опубликовать. По умолчанию 36 × 5 с = 3 минуты.
  // ПОЧЕМУ НЕ МЕНЬШЕ: минуты на минутный ролик Meta не хватает, а истёкшее ожидание — это не
  // «подождём ещё», а publish_failed на исправном видео. Ждать дешевле, чем разбираться с ложной
  // ошибкой: кнопка «Одобрить» отвечается сразу, до публикации, поэтому ожидание ничего не блокирует.
  igPollMs: Number(process.env.IG_POLL_MS || 5_000),
  igStatusAttempts: Number(process.env.IG_STATUS_ATTEMPTS || 36),

  // ── Вариант C: публикация живым браузером (решение владельца 15.09.2026) ──
  // api (по умолчанию) — публикуем через Graph API, как раньше; browser — заходим в аккаунт
  // клиента живым браузером и постим через веб-интерфейс. Путь через API остаётся рабочим:
  // если браузерная сессия упрётся в проверку, возврат к API — это смена одной переменной.
  igMode: (process.env.IG_MODE || 'api').trim().toLowerCase(),

  // Логин и пароль аккаунта клиента. Заполняются ТОЛЬКО на VPS, в git не попадают.
  igLogin: process.env.IG_LOGIN || null,
  igPassword: process.env.IG_PASSWORD || null,

  // Профиль браузера: здесь живут куки сессии. Папка постоянная — иначе каждый запуск диспетчера
  // был бы новым входом, а серия входов гарантированно уводит аккаунт в проверку.
  // Рядом с SQLite, потому что это такое же состояние, которое нельзя терять и нельзя коммитить.
  igProfileDir: process.env.IG_PROFILE_DIR || path.join(DISPATCHER_DIR, 'data', 'browser-profile'),

  // Скриншоты проверок входа: без картинки просьба «пришлите код» — это просьба вслепую.
  igShotsDir: process.env.IG_SHOTS_DIR || path.join(DISPATCHER_DIR, 'data', 'browser-shots'),

  // Показать окно браузера. На VPS окна нет, это только для отладки на машине с экраном.
  igHeadful: process.env.IG_HEADFUL === '1',

  // ── T15: приём готового ролика с ноута клиента ────────────────────────
  // Монтаж идёт на ноуте (Bot API качает только до 20 МБ), готовый лёгкий ролик приезжает по SSH
  // и кладётся в ту же публичную статику, что кадры и PDF: Instagram качает Reels по video_url.
  videoPublicSubdir: process.env.VIDEO_PUBLIC_SUBDIR || 'video',

  // Потолок размера принимаемого ролика. Защита диска VPS и напоминание, что сюда приезжает
  // смонтированный ролик, а не исходники.
  videoMaxBytes: Number(process.env.VIDEO_MAX_MB || 300) * 1024 * 1024,

  // ── T09: тренды (сбор через Apify) ────────────────────────────────────
  // Основной путь сбора — Apify (решение клиента 07.09.2026): актор ходит в IG/Threads сам,
  // мы никуда не логинимся. Токен и id акторов вводит КЛИЕНТ при установке, список аккаунтов
  // и хэштегов лежит в видимом trends/sources.json (см. trends/README.md).
  apifyToken: process.env.APIFY_TOKEN || null,
  apifyBaseUrl: process.env.APIFY_BASE_URL || 'https://api.apify.com/v2',
  apifyTimeoutMs: Number(process.env.APIFY_TIMEOUT_MS || 300_000),
  apifyPollMs: Number(process.env.APIFY_POLL_MS || 5_000),

  // Акторы из .env перебивают поле actor в sources.json — сменить актор можно, не трогая JSON.
  apifyActors: {
    ig: process.env.APIFY_ACTOR_IG || null,
    threads: process.env.APIFY_ACTOR_THREADS || null,
  },

  // apify (основной) | login (резервный вариант C, не реализован — см. src/trends/providers.js).
  trendsProvider: process.env.TRENDS_PROVIDER || 'apify',

  // Кого смотреть. Файл вне dispatcher/ — это данные клиента, а не код.
  trendsSourcesPath: process.env.TRENDS_SOURCES || path.join(ROOT, 'trends', 'sources.json'),

  // Время суточного автозапуска сбора, HH:MM. Пусто = только вручную командой «/тренды».
  trendsAt: process.env.TRENDS_AT || null,

  // ── T16: Аналитик, метрики и автомонтаж ──────────────────────────────
  // Отчёт собирается по фактам собственной базы и работает без единой настройки. Метрики площадок
  // (охваты, просмотры) — необязательное дополнение: им нужны отдельные права *_manage_insights,
  // которые клиент выдаёт себе сам в dev-mode. По умолчанию выключено.
  analyticsInsights: process.env.ANALYTICS_INSIGHTS === '1',

  // Время еженедельного автоотчёта, HH:MM по времени сервера. Пусто = только вручную «/отчёт».
  analyticsAt: process.env.ANALYTICS_AT || null,

  // День недели автоотчёта: 0 — воскресенье, 1 — понедельник (по умолчанию).
  analyticsWeekday: Number(process.env.ANALYTICS_WEEKDAY ?? 1),

  // За сколько дней считается автоотчёт.
  analyticsDays: Number(process.env.ANALYTICS_DAYS || 7),

  // ── T18: «Мозг бренда» — приёмник идей и материалов клиента ──────────
  // Идеи дописываются в слот «Входящие» (его, как и остальные слоты, агенты читают перед каждой
  // задачей), файлы ложатся рядом в materials/. Оба пути внутри brand-brain/ нарочно: это данные
  // клиента, и на хендовере они должны лежать там, где их ищет человек.
  brainInboxPath: path.join(BRAND_BRAIN_DIR, '09-inbox.md'),
  brainMaterialsDir: path.join(BRAND_BRAIN_DIR, 'materials'),

  // Нейтральная рабочая папка для подпроцесса claude -p:
  // чтобы агент не подхватывал строительный CLAUDE.md репозитория —
  // все инструкции агент получает из промпта (см. src/agent.js).
  claudeCwd: process.env.CLAUDE_CWD || os.tmpdir(),
};
