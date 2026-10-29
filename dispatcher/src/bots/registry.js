// Реестр бот-идентичностей диспетчера.
//
// СЕЙЧАС (Фаза 0, T01): активен только спайн-бот — доказывает хребет «TG → claude -p → TG».
// ПОТОМ (T03): к нему по одному-двум за сессию добавляются 6 боевых агентов.
// Пошаговый план добавления — specs/bots-rollout-plan.md. Пока НЕ раскомментировать всё скопом:
// каждый новый агент = свой токен в .env + свой файл agents/<key>.md.
//
// Поле `agent`:
//   null            → сырой прогон текста через `claude -p` (демо спайна T01);
//   '<key>'         → полноценный агент по контракту (читает agents/<key>.md + brand-brain).

export const BOT_IDENTITIES = [
  {
    key: 'dispatcher',
    title: 'Спайн-диспетчер (T01)',
    tokenEnv: 'TELEGRAM_BOT_TOKEN',
    agent: null,
    topicEnv: null,
  },

  // ── T03-A: первый боевой бот ──
  { key: 'writer', title: 'Сценарист', tokenEnv: 'BOT_TOKEN_WRITER', agent: 'writer', topicEnv: 'TOPIC_WRITER' },

  // ── T03-B: оркестрация + публикация (ядро Фазы 1) ──
  // Агенты работают по контракту (agents/producer.md, agents/publisher.md): Продюсер выдаёт план
  // и список задач, Издатель — предпубликационную проверку. Раздачу и исполнение задач Продюсера
  // уже делает код (T05, src/orchestrator.js); очередь/кнопки/публикация — ещё впереди (T07/T08).
  { key: 'producer',  title: 'Продюсер', tokenEnv: 'BOT_TOKEN_PRODUCER',  agent: 'producer',  topicEnv: 'TOPIC_PRODUCER'  },
  { key: 'publisher', title: 'Издатель', tokenEnv: 'BOT_TOKEN_PUBLISHER', agent: 'publisher', topicEnv: 'TOPIC_PUBLISHER' },

  // ── T03-C: тренды + визуал (Фаза 2) ──
  // Тоже пока «думающая» часть: Разведчик выдаёт ПЛАН парсинга и разбор тем из данных, которые ему
  // дали; сам он в IG/Threads не ходит — логин по варианту C, прокси и Apify-резерв это T09.
  // Дизайнер выдаёт СПЕЦИФИКАЦИЮ карусели/обложки, а рендер по ней уже боевой (T10, render/):
  // готовые PNG сами уходят альбомом в его топик и над карточкой согласования.
  { key: 'scout',    title: 'Разведчик', tokenEnv: 'BOT_TOKEN_SCOUT',    agent: 'scout',    topicEnv: 'TOPIC_SCOUT'    },
  { key: 'designer', title: 'Дизайнер',  tokenEnv: 'BOT_TOKEN_DESIGNER', agent: 'designer', topicEnv: 'TOPIC_DESIGNER' },

  // ── T03-D: инста-воронка (Фаза 3) ──
  // Тоже «думающая» часть: Презентатор выдаёт СТРУКТУРУ PDF-презентации (лид-магнита воронки);
  // сама сборка PDF через render/, раздача по Nginx-статике и сохранение URL — это T13,
  // а 3 ключа ManyChat → 3 ссылки — T14.
  { key: 'presenter', title: 'Презентатор', tokenEnv: 'BOT_TOKEN_PRESENTER', agent: 'presenter', topicEnv: 'TOPIC_PRESENTER' },

  // ── T16 (Фаза 5): видео и аналитика ──
  // ВИДЕО — бот-НОТИФИКАТОР, а не думающий агент: `agent: null` здесь осознанный. Монтаж живёт на
  // ноуте клиента, и на VPS думать за него нечем: бот показывает заявки на монтаж («/видео»),
  // сообщает о новых и объясняет, как залить готовый ролик. Вызовов claude -p он не делает.
  { key: 'video', title: 'Видео', tokenEnv: 'BOT_TOKEN_VIDEO', agent: null, topicEnv: 'TOPIC_VIDEO' },

  // АНАЛИТИК — наоборот, полноценный агент (agents/analyst.md): цифры ему считает диспетчер
  // (src/analytics), а он объясняет их и предлагает, что менять.
  { key: 'analyst', title: 'Аналитик', tokenEnv: 'BOT_TOKEN_ANALYST', agent: 'analyst', topicEnv: 'TOPIC_ANALYST' },

  // ── T18: «Мозг бренда» — приёмник идей и материалов клиента ──
  // Тоже НЕ думающий агент (`agent: null`): клиент шлёт идеи, пересланные посты, фото, видео и
  // файлы, а диспетчер складывает их в brand-brain (слот 09-inbox.md + папка materials/). Вызовов
  // claude -p бот не делает — агенты прочтут накопленное сами, перед каждой задачей.
  { key: 'brain', title: 'Мозг бренда', tokenEnv: 'BOT_TOKEN_BRAIN', agent: null, topicEnv: 'TOPIC_BRAIN' },
];

/** Достаёт из окружения токен и id топика для идентичности. topicId=null → у бота нет своего топика. */
export function resolveIdentity(entry, env = process.env) {
  const topicRaw = entry.topicEnv ? env[entry.topicEnv] : null;
  return {
    ...entry,
    token: env[entry.tokenEnv]?.trim() || null,
    topicId: topicRaw && topicRaw.trim() ? Number(topicRaw) : null,
  };
}

/** Идентичности с реально заданным токеном, уже с резолвнутыми token/topicId. */
export function enabledIdentities(env = process.env) {
  return BOT_IDENTITIES.filter((b) => env[b.tokenEnv]?.trim()).map((b) => resolveIdentity(b, env));
}
