// Точка входа диспетчера. Грузит включённые бот-идентичности из реестра, поднимает по grammY-боту
// на каждую и вешает единый обработчик текста: агент по контракту (claude -p) → ответ обратно в чат.
//
// «Тупая труба»: тут только маршрутизация и I/O. Весь интеллект — в claude.js/agent.js через claude -p.

import { Bot } from 'grammy';
import { enabledIdentities } from './bots/registry.js';
import { isOwner, parseOwnerIds, shouldHandle } from './bots/router.js';
import { postToTopic, splitForTelegram } from './bots/send.js';
import { runClaude } from './claude.js';
import { runAgent } from './agent.js';
import { openDb } from './db/index.js';
import { config } from './config.js';
import {
  dispatchPlan,
  extractTasks,
  isStatusCommand,
  renderDispatchSummary,
  renderStatus,
} from './orchestrator.js';
import { enqueueAgentResult, registerApprovalHandlers } from './queue/approval.js';
import { isQueueCommand, parseSlotCommand, renderQueueList } from './queue/card.js';
import { reworkDraft } from './queue/rework.js';
import { platformStatuses, publishItem } from './publish/index.js';
import { parsePreflightCommand, preflight, renderPreflight } from './publish/preflight.js';
import {
  hasPendingCode,
  parseLoginCommand,
  renderSessionStatus,
  runLoginFromTopic,
  submitCode,
} from './publish/browser/login-command.js';
import { startPublishScheduler } from './publish/scheduler.js';
import { parseRenderCommand, rerenderQueueItem } from './render/visuals.js';
import { buildFunnelPdfs, parsePdfCommand, renderFunnelList, renderPdfReport } from './funnel/pdf.js';
import { funnelSnapshot, renderSyncReport, syncFunnelFields } from './funnel/manychat.js';
import { parseFunnelCommand, renderFunnelState, renderFunnelTest, renderSetupCard } from './funnel/reply.js';
import { parseTrendsCommand, runTrends, startTrendsScheduler } from './trends/run.js';
import { createJobFromItem, needsMontage, parseVideoCommand, renderJob, renderJobsList, renderNewJobNotice } from './video/jobs.js';
import { parseReportCommand } from './analytics/report.js';
import { renderReport, runReport, startAnalyticsScheduler } from './analytics/run.js';
import {
  BRAIN_HELP,
  BRAIN_VOICE_HINT,
  createAlbumCollector,
  createBrainInbox,
  describeMedia,
  forwardLabel,
  parseBrainCommand,
  renderIdeaReply,
  renderInboxSummary,
  renderMaterialReply,
} from './brain/inbox.js';

/** Ключ агента-оркестратора: только его план разбирается на задачи (T05). */
const PRODUCER_KEY = 'producer';

/** Ключ Издателя: в его топике висят карточки согласования и он ловит нажатия кнопок (T07). */
const PUBLISHER_KEY = 'publisher';

/** Ключ Дизайнера: в его топике появляются отрендеренные карусели и обложки (T10). */
const DESIGNER_KEY = 'designer';

/** Ключ Разведчика: в его топике живёт сбор трендов и отчёт по темам (T09). */
const SCOUT_KEY = 'scout';

/** Ключ Презентатора: в его топике собираются PDF-лид-магниты инста-воронки (T13). */
const PRESENTER_KEY = 'presenter';

/** Ключ Видео (T16): бот-нотификатор — заявки на монтаж, который идёт на ноуте клиента. */
const VIDEO_KEY = 'video';

/** Ключ Аналитика (T16): отчёт по фактам конвейера в его топике. */
const ANALYST_KEY = 'analyst';

/** Ключ «Мозга бренда» (T18): приёмник идей и материалов клиента, claude -p не зовёт. */
const BRAIN_KEY = 'brain';

/** user_id, про которых при выключенном фильтре уже напечатана строка [access], — чтобы не засорять журнал. */
const seenWhileOpen = new Set();

/**
 * Печатает на старте, кому боты отвечают. Нужна потому, что OWNER_IDS ломается ТИХО: «@username» или
 * «123;456» разбираются в пустой список, а пустой список — это выключенный фильтр.
 */
function logAccessPolicy(identities) {
  const raw = String(process.env.OWNER_IDS || '').trim();
  const tokens = raw ? raw.split(/[,\s]+/).filter(Boolean) : [];
  const junk = tokens.filter((t) => parseOwnerIds(t).size === 0);
  if (junk.length) {
    console.warn(`⚠️ OWNER_IDS: пропущено, это не user_id — ${junk.join(', ')} (нужны числа через запятую).`);
  }
  if (config.ownerIds.size > 0) {
    console.log(`Доступ: только владельцы — ${[...config.ownerIds].join(', ')}.`);
    return;
  }
  console.warn(
    tokens.length
      ? '⚠️ OWNER_IDS задан, но ни одного user_id в нём не распознано — фильтр ВЫКЛЮЧЕН, боты отвечают всем.'
      : '⚠️ OWNER_IDS пуст — боты отвечают всем, кто им напишет. На боевом сервере заполнить (см. .env.example).',
  );
  if (identities.some((i) => i.key === BRAIN_KEY)) {
    console.warn('⚠️ «Мозг бренда» при пустом OWNER_IDS записывает в brand-brain присланное КЕМ УГОДНО — это читают все агенты.');
  }
}

/**
 * «/pdf@PresenterBot список» → «/pdf список». В группе, где ботов несколько, Telegram дописывает к
 * команде из меню имя бота, а разборщики команд его в большинстве не ждут — и команда уходила бы
 * агенту как задача, то есть лишним вызовом claude -p. Снимается только СВОЁ имя.
 */
function stripOwnMention(text, username) {
  const m = /^(\/[^\s@]+)@(\w+)/u.exec(String(text || ''));
  if (!m || !username || m[2].toLowerCase() !== String(username).toLowerCase()) return text;
  return m[1] + text.slice(m[0].length);
}

/**
 * Общий вход для любого входящего сообщения: своё ли это место и свой ли человек.
 * Один на текст и на файлы — иначе фильтры разъехались бы, и в «Мозг бренда» мог бы писать кто угодно.
 * @returns {Promise<boolean>} можно ли обрабатывать
 */
async function admit(identity, ctx) {
  // Роутер: обрабатываем только свою личку и свой топик; чужое молча игнорируем.
  if (!shouldHandle(identity, ctx)) return false;

  // Фильтр выключен (OWNER_IDS пуст) — пускаем, но user_id печатаем, по разу на человека. Это и
  // есть способ узнать, что вписать в OWNER_IDS: без этой строки при пустом списке её не было бы вовсе.
  if (config.ownerIds.size === 0) {
    const id = ctx.from?.id;
    if (id != null && !seenWhileOpen.has(id)) {
      seenWhileOpen.add(id);
      console.warn(
        `[access] OWNER_IDS пуст, пускаю всех: bot=${identity.key} user_id=${id} ` +
          `@${ctx.from?.username ?? '—'} chat=${ctx.chat?.type}`,
      );
    }
    return true;
  }

  // Allowlist владельцев: посторонний не должен жечь вызовы claude -p на подписке клиента
  // (и писать в его мозг бренда). В личке отвечаем ЯВНО (молчащий бот неотличим от сломанного,
  // и клиент, забывший вписать свой id, чинил бы его вслепую), в группе молчим — там лишнее уже
  // отсеял фильтр топика. В лог печатается user_id: это и есть способ узнать, что вписать в OWNER_IDS.
  if (!isOwner(ctx, config.ownerIds)) {
    console.warn(
      `[access] отказано: bot=${identity.key} user_id=${ctx.from?.id} ` +
        `@${ctx.from?.username ?? '—'} chat=${ctx.chat?.type}`,
    );
    if (ctx.chat?.type === 'private') {
      await ctx.reply('⛔ Нет доступа: бот работает только для владельца.').catch(() => {});
    }
    return false;
  }
  return true;
}

/**
 * Превращает входящий текст в ответ: полноценный агент или сырой прогон через claude -p (спайн).
 * @returns {Promise<{text:string, meta:object|null}>} meta нужен оркестрации (tasks[] Продюсера).
 */
async function produceReply(identity, text) {
  if (identity.agent) {
    const res = await runAgent({ agentKey: identity.agent, task: text });
    if (!res.ok) return { text: `⚠️ Ошибка агента «${identity.agent}»: ${res.error}`, meta: null };
    return { text: res.content, meta: res.meta };
  }
  const r = await runClaude({ prompt: text });
  return {
    text: r.ok ? r.text || '(пустой ответ от Claude Code)' : `⚠️ Ошибка claude -p: ${r.error}`,
    meta: null,
  };
}

/** Отправляет длинный текст частями (≤ TG_LIMIT), в тот же топик, что и входящее. */
async function replyChunked(ctx, text) {
  // В форум-группе ответ должен уйти в тот же топик → пробрасываем message_thread_id.
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  for (const part of splitForTelegram(text)) {
    await ctx.reply(part, opts);
  }
}

/**
 * Оркестрация после ответа Продюсера (T05): разложить его tasks[] по топикам и исполнить.
 * Живёт отдельно от ответа пользователю: план показываем сразу, раздача идёт следом.
 * @param {object} runtime  { db, botsByKey } — общее состояние процесса (см. main)
 */
async function orchestrateProducerPlan(ctx, runtime, meta) {
  // Исполнители = поднятые боты-агенты, кроме самого Продюсера (себе задач не ставит)
  // и спайн-бота T01 (у него нет роли-агента).
  const executors = [...runtime.botsByKey.values()]
    .filter((e) => e.identity.agent && e.identity.key !== PRODUCER_KEY)
    .map((e) => e.identity.key);

  const { tasks, skipped } = extractTasks(meta, executors);
  if (!tasks.length && !skipped.length) return; // просто вопрос/сводка — раздавать нечего

  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  if (!config.forumGroupId) {
    // В личке Продюсера топиков нет: раздавать физически некуда — говорим честно, а не молчим.
    await ctx.reply('⚠️ Раздача задач работает только в форум-группе (не задан FORUM_GROUP_ID).', opts);
    return;
  }

  if (tasks.length) await ctx.reply(`📤 Раздаю задач: ${tasks.length}. Исполняю по очереди…`, opts);

  const results = await dispatchPlan({
    tasks,
    goal: typeof meta?.title === 'string' ? meta.title : null,
    db: runtime.db,
    groupId: config.forumGroupId,
    botsByKey: runtime.botsByKey,
    producerKey: PRODUCER_KEY,
  });

  const summary = renderDispatchSummary(results, skipped);
  if (summary) await ctx.reply(summary, opts);
}

/** Топик Издателя и его бот — единая точка, где живут карточки согласования. */
function publisherSeat(runtime) {
  const seat = runtime.botsByKey.get(PUBLISHER_KEY);
  return { bot: seat?.bot ?? null, topicId: seat?.identity?.topicId ?? null };
}

/**
 * Правка (T07): владелец ответил реплаем на карточку → зовём агента-автора переделать черновик,
 * новая версия встаёт в очередь новой карточкой, старая уходит в superseded.
 */
async function handleEditReply(ctx, runtime, item, note) {
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  const by = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? 'кто-то');
  runtime.db.queue.decide(item.id, 'needs_edit', { by, note }); // фиксируем текст правки у родителя

  await ctx.reply(`✏️ Принял правку по #${item.id}. Зову ${item.agent} на доработку…`, opts);
  const seat = publisherSeat(runtime);
  const res = await reworkDraft({
    db: runtime.db,
    item,
    note,
    publisherBot: seat.bot,
    groupId: config.forumGroupId,
    topicId: seat.topicId,
  });

  await ctx.reply(
    res.ok
      ? `🗂 Готова новая версия #${res.id} (правка к #${item.id}) — карточка выше.`
      : `⚠️ Доработка #${item.id} не удалась: ${res.error}. Правку можно прислать ещё раз.`,
    opts,
  );
}

/** Публикуемый ответ агента в его собственном топике тоже уходит на согласование (T07). */
async function enqueueDirectDraft(ctx, runtime, identity, meta, content) {
  const res = await enqueueAgentResult({
    db: runtime.db,
    agent: identity.agent,
    meta,
    content,
    botsByKey: runtime.botsByKey,
    groupId: config.forumGroupId,
  });
  if (!res.enqueued) return;

  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  await ctx.reply(renderEnqueueReply(res), opts);
}

/**
 * Что сказать в топик после постановки черновика в очередь.
 * Рендер визуала (T10) вынесен в отдельную строку и НЕ отменяет постановку: если картинки не
 * получились, черновик всё равно на согласовании, а причина видна человеку сразу, а не в логах.
 */
function renderEnqueueReply(res) {
  const lines = [
    res.error
      ? `🗂 Черновик #${res.id} в очереди, но карточку показать не удалось: ${res.error}`
      : `🗂 Черновик #${res.id} отправлен на согласование в топик Издателя.`,
  ];
  if (res.images?.length) lines.push(`🖼 Картинок отрендерено: ${res.images.length} · ${res.visualNote}`);
  if (res.visualError) lines.push(`⚠️ Визуал: ${res.visualError}\nПовторить рендер — «/рендер ${res.id}».`);
  return lines.join('\n');
}

/**
 * «/рендер 12» в топике Дизайнера — перерисовать визуал уже стоящего в очереди черновика.
 * Агент при этом НЕ вызывается: спецификация берётся из БД, вызов claude -p не тратится.
 */
async function handleRenderCommand(ctx, runtime, id) {
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  await ctx.reply(`🎨 Перерисовываю визуал #${id}…`, opts);

  const res = await rerenderQueueItem({
    db: runtime.db,
    id,
    botsByKey: runtime.botsByKey,
    groupId: config.forumGroupId,
  });

  await ctx.reply(
    res.ok
      ? `✅ Готово: картинок ${res.files.length} · ${res.note}${res.error ? `\n⚠️ ${res.error}` : ''}`
      : `⚠️ Не удалось: ${res.error}`,
    opts,
  );
}

/**
 * «/тренды» в топике Разведчика (T09): собрать посты через Apify и разобрать их в темы.
 * Отчёт печатается прямо в этот же чат — команда пришла к Разведчику, отчёту место рядом с ней.
 * Ничего в очередь согласования не идёт: trend_report — это сырьё для тем, а не публикуемый контент.
 */
async function handleTrendsCommand(ctx, runtime, { force, plain }) {
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  // Команду словами подтверждаем вслух: прогон актора платный, и владелец должен видеть, что
  // «тренды» прочитались как приказ, а не как начало разговора.
  const hint = plain
    ? '\nℹ️ Прочитал это как команду сбора. Обсудить тренды без прогона — фразой: «расскажи про тренды в нише».'
    : '';
  await ctx.reply(
    (force ? '🔎 Собираю тренды (осознанный обход суточного лимита)…' : '🔎 Собираю тренды…') + hint,
    opts,
  );

  const res = await runTrends({
    db: runtime.db,
    config,
    force,
    onLog: (m) => console.log(m),
  });

  await replyChunked(ctx, res.report || res.summary);
  // Заметки сбора (какой актор, сколько отдал, что упало по площадке) — отдельной строкой:
  // в отчёте Разведчика им не место, а для настройки они важны.
  if (res.notes?.length) await ctx.reply(`ℹ️ ${res.notes.join('\n')}`, opts).catch(() => {});
}

/**
 * «/пдф» в топике Презентатора (T13): собрать PDF-лид-магниты по темам воронки.
 * «/пдф <ключ>» — пересобрать одну тему, «/пдф список» — показать, что воронка отдаёт сейчас
 * (это чтение из БД: ни агент, ни браузер не дёргаются).
 *
 * Сборка ДОЛГАЯ и платная: на каждую тему уходит вызов claude -p плюс запуск браузера. Поэтому
 * запускается только руками — расписания у неё нет: три темы меняются раз в сезон, а не ежедневно.
 */
async function handlePdfCommand(ctx, runtime, cmd) {
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};

  if (cmd.list) {
    await replyChunked(ctx, renderFunnelList(runtime.db.funnel.list()));
    return;
  }

  await ctx.reply(
    cmd.key
      ? `📄 Пересобираю PDF по теме «${cmd.key}»…`
      : '📄 Собираю PDF воронки: по вызову агента и рендеру на тему, это займёт пару минут…',
    opts,
  );

  const res = await buildFunnelPdfs({
    db: runtime.db,
    config,
    botsByKey: runtime.botsByKey,
    groupId: config.forumGroupId,
    presenterKey: PRESENTER_KEY,
    key: cmd.key,
    onLog: (m) => console.log(m),
  });

  await replyChunked(ctx, renderPdfReport(res));

  // Свежие ссылки сразу уезжают в bot-поля ManyChat (T14): иначе в директе останется старый адрес,
  // а человек получит 404. Без MANYCHAT_TOKEN шаг молча пропускается — это ещё не настроено.
  if (config.manychatToken && res.results.some((r) => r.ok && r.url)) {
    const sync = await syncFunnelFields({ db: runtime.db, config, onLog: (m) => console.log(m) });
    await replyChunked(ctx, renderSyncReport(sync));
  }
}

/**
 * «/воронка» в топике Презентатора (T14): что инста-воронка отдаёт прямо сейчас.
 * «/воронка настройка» — карточка для UI ManyChat, «/воронка синх» — записать ссылки в bot-поля,
 * «/воронка тест <ключ>» — репетиция: что придёт человеку в директ по этому ключу.
 *
 * Всё, кроме «синх», читается из БД и конфига: ни агент, ни ManyChat не дёргаются.
 */
async function handleFunnelCommand(ctx, runtime, cmd) {
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};

  if (cmd.action === 'sync') {
    await ctx.reply('🔗 Записываю ссылки в bot-поля ManyChat…', opts);
    const sync = await syncFunnelFields({ db: runtime.db, config, onLog: (m) => console.log(m) });
    await replyChunked(ctx, renderSyncReport(sync));
    return;
  }

  const snapshot = funnelSnapshot({ db: runtime.db, config });
  if (!snapshot.ok) {
    await replyChunked(ctx, `⚠️ ${snapshot.error}`);
    return;
  }

  const text = {
    state: () => renderFunnelState(snapshot.view, {
      hasToken: Boolean(config.manychatToken),
      dryRun: config.manychatDryRun,
    }),
    setup: () => renderSetupCard(snapshot.view, { hasToken: Boolean(config.manychatToken) }),
    test: () => renderFunnelTest(snapshot.view, cmd.key),
  }[cmd.action]();

  await replyChunked(ctx, text);
}

/** Что бот Видео умеет: сам он не монтирует — монтаж идёт на ноуте клиента. */
const VIDEO_HELP = [
  '🎬 Я показываю заявки на монтаж — монтирую не я, а ноутбук клиента.',
  '',
  '«/видео» — что ждёт монтажа',
  '«/видео 3» — сценарий заявки №3 целиком',
  '«/видео отмена 3» — снять заявку',
  '',
  'На ноуте: ./video/pull-jobs.sh → смонтировать → ./video/upload.sh <файл> --job <N>.',
  'Готовый ролик приедет карточкой в топик Издателя.',
].join('\n');

/** «/видео …» в топике Видео (T16): заявки на монтаж. Читает БД, claude -p не зовёт. */
async function handleVideoCommand(ctx, runtime, cmd) {
  const { videoJobs } = runtime.db;

  if (cmd.action === 'cancel') {
    const ok = videoJobs.cancel(cmd.id, 'снята вручную в топике Видео');
    await replyChunked(ctx, ok ? `🚫 Заявка #${cmd.id} снята.` : `⚠️ Заявки #${cmd.id} нет или она уже закрыта.`);
    return;
  }
  if (cmd.action === 'show') {
    await replyChunked(ctx, renderJob(videoJobs.getById(cmd.id)));
    return;
  }
  if (cmd.action === 'help') {
    await replyChunked(ctx, VIDEO_HELP);
    return;
  }
  await replyChunked(ctx, renderJobsList(videoJobs.list({ status: 'open' }), videoJobs.countsByStatus()));
}

/**
 * Сообщает в топик Видео о новой заявке на монтаж (T16).
 * @returns {Promise<boolean>} дошло ли уведомление (бот Видео может быть и не поднят)
 */
async function notifyMontageJob(runtime, job) {
  const seat = runtime.botsByKey.get(VIDEO_KEY);
  if (!seat?.bot || !config.forumGroupId || seat.identity.topicId == null) return false;
  await seat.bot.api.sendMessage(config.forumGroupId, renderNewJobNotice(job), {
    message_thread_id: seat.identity.topicId,
  });
  return true;
}

/**
 * «/отчёт» в топике Аналитика (T16): факты конвейера из БД + выводы агента.
 * Цифры считает код, агент вызывается ровно один раз — на выводы (см. src/analytics/report.js).
 */
async function handleReportCommand(ctx, runtime, cmd) {
  const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};
  await ctx.reply(`📊 Собираю отчёт за ${cmd.days} дн.…`, opts);

  const res = await runReport({ db: runtime.db, config, days: cmd.days, onLog: (m) => console.log(m) });
  await replyChunked(ctx, renderReport(res));
}

/**
 * Текст в топике «Мозг бренда» (T18): команда или идея. Идея дописывается во «Входящие» как есть —
 * агент при этом не вызывается, записанное прочтут все агенты перед следующей задачей.
 */
async function handleBrainText(ctx, brain) {
  const cmd = parseBrainCommand(ctx.message.text);
  if (cmd?.action === 'list') {
    await replyChunked(ctx, renderInboxSummary(await brain.inbox.summary()));
    return;
  }
  if (cmd?.action === 'help') {
    await replyChunked(ctx, BRAIN_HELP);
    return;
  }
  const res = await brain.inbox.addIdea({
    text: ctx.message.text,
    forwardedFrom: forwardLabel(ctx.message.forward_origin),
  });
  await replyChunked(ctx, renderIdeaReply(res));
}

/**
 * Файл в топике «Мозг бренда» (T18): скачать в brand-brain/materials/ и записать строку каталога.
 * Части альбома отвечают одним сообщением на весь альбом (см. createAlbumCollector).
 */
async function handleBrainMedia(ctx, identity, brain) {
  const msg = ctx.message;
  if (msg.voice) {
    await replyChunked(ctx, BRAIN_VOICE_HINT);
    return;
  }
  const media = describeMedia(msg);
  if (!media) return;

  const album = msg.media_group_id;
  if (album) brain.albums.start(album, ctx);
  const res = await brain.inbox
    .addMaterial({
      api: ctx.api,
      token: identity.token,
      media,
      caption: msg.caption,
      messageId: msg.message_id,
      forwardedFrom: forwardLabel(msg.forward_origin),
    })
    .catch((err) => ({ ok: false, kind: media.kind, error: err.message }));

  if (album) brain.albums.done(album, res);
  else await replyChunked(ctx, renderMaterialReply([res]));
}

/**
 * Одобрено (T08): публикуем в канал сразу. Если у элемента задан слот на будущее — он уходит
 * в `scheduled`, и отправит его планировщик. В канал попадает только одобренное — проверка
 * внутри publishItem, обойти её мимо кнопки нельзя.
 */
async function handleApproved(ctx, runtime, item) {
  const res = await publishItem({
    db: runtime.db,
    item,
    botsByKey: runtime.botsByKey,
    channelId: config.tgChannelId,
  });

  const text = {
    published: `📣 #${item.id} опубликован в канале.`,
    scheduled: `🗓 #${item.id} поставлен в расписание — ${res.reason}.`,
    skipped: `ℹ️ #${item.id} не публикуется: ${res.reason}`,
    failed: `⚠️ #${item.id} не опубликован: ${res.error}`,
  }[res.status];

  const opts = ctx.callbackQuery?.message?.message_thread_id
    ? { message_thread_id: ctx.callbackQuery.message.message_thread_id }
    : {};

  // Автомонтаж (T16): одобренный сценарий Reels публиковать нечем — из него рождается ЗАЯВКА на
  // монтаж, и ноутбук клиента заберёт её сам. Иначе цепочка обрывалась: сценарий одобрен, а дальше
  // тишина. Повторное «Одобрить» дубля не создаёт.
  const montage = needsMontage(item) ? createJobFromItem({ db: runtime.db, item }) : null;
  let tail = '';
  if (montage) {
    const job = runtime.db.videoJobs.getById(montage.id);
    const notified = await notifyMontageJob(runtime, job).catch((err) => {
      console.error('[video] уведомление о заявке:', err.message);
      return false;
    });
    const where = notified
      ? ' — подробности в топике Видео.'
      : ' (бот Видео не поднят: смотри «npm run video:jobs» на VPS).';
    tail = montage.created
      ? `\n🎬 Заявка на монтаж #${montage.id}${where}`
      : `\n🎬 Заявка на монтаж #${montage.id} уже была — новая не создаётся.`;
  }

  await ctx.reply(text + tail, opts).catch((err) => console.error('[publisher] ответ о публикации:', err.message));
}

function buildBot(identity, runtime) {
  const bot = new Bot(identity.token);

  // Кнопки карточек согласования слушает только Издатель — карточки висят в его топике.
  if (identity.key === PUBLISHER_KEY) {
    registerApprovalHandlers(bot, runtime, {
      onApproved: (ctx, item) => handleApproved(ctx, runtime, item),
    });
  }

  // «Мозг бренда» (T18) — единственный бот, который принимает файлы. Остальным файлы не нужны:
  // их вход — текст задачи, и лишний обработчик там только путал бы.
  const brain =
    identity.key === BRAIN_KEY
      ? {
          inbox: createBrainInbox({ inboxPath: config.brainInboxPath, materialsDir: config.brainMaterialsDir }),
          albums: createAlbumCollector({ onFlush: (ctx, results) => replyChunked(ctx, renderMaterialReply(results)) }),
        }
      : null;
  if (brain) {
    bot.on(['message:photo', 'message:video', 'message:video_note', 'message:audio', 'message:document', 'message:voice'], async (ctx) => {
      if (!(await admit(identity, ctx))) return;
      try {
        await handleBrainMedia(ctx, identity, brain);
      } catch (err) {
        console.error(`[${identity.key}] media error:`, err);
        await ctx.reply('⚠️ Внутренняя ошибка диспетчера — см. логи.').catch(() => {});
      }
    });
  }

  bot.on('message:text', async (ctx) => {
    // Помощник настройки: с DEBUG_IDS=1 бот печатает id чата и топика для КАЖДОГО сообщения
    // (до фильтра роутера) — так узнаёшь FORUM_GROUP_ID и TOPIC_*, чтобы вписать в .env.
    if (process.env.DEBUG_IDS) {
      // Текст печатаем тоже: по нему сопоставляешь, какой thread какому топику принадлежит
      // (в Bot API нет метода «перечислить топики форума»).
      console.log(
        `[ids] bot=${identity.key} chat.id=${ctx.chat?.id} type=${ctx.chat?.type} ` +
          `thread=${ctx.message?.message_thread_id ?? '—'} text=${JSON.stringify(ctx.message.text.slice(0, 40))}`,
      );
    }
    // Роутер (своё место) + allowlist владельцев (свой человек) — см. admit().
    if (!(await admit(identity, ctx))) return;
    try {
      const opts = ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {};

      // Команды разбираются без «@имя_бота»: так их шлёт меню команд в группе (см. stripOwnMention).
      const cmdText = stripOwnMention(ctx.message.text, ctx.me?.username);

      // «/статус» у Продюсера отвечает из БД, а не через claude -p: статусы помнит диспетчер.
      if (identity.key === PRODUCER_KEY && isStatusCommand(cmdText)) {
        await replyChunked(ctx, renderStatus(runtime.db));
        return;
      }

      // «/очередь» у Издателя — тоже из БД: что сейчас ждёт решения владельца.
      if (identity.key === PUBLISHER_KEY && isQueueCommand(cmdText)) {
        const { queue } = runtime.db;
        await replyChunked(ctx, renderQueueList(queue.listPending(), queue.countsByStatus()));
        return;
      }

      // «/проверка» у Издателя — предполётная диагностика публикации. Ничего не публикует и не
      // зовёт claude -p: только читает Graph API и пробует забрать свой же файл из публичной
      // статики. Это первое, что запускается, когда приехали креды клиента.
      if (identity.key === PUBLISHER_KEY && parsePreflightCommand(cmdText)) {
        await ctx.reply('🔎 Проверяю настройку публикации (ничего не публикую)…', opts);
        const res = await preflight({ config });
        await replyChunked(ctx, renderPreflight(res));
        return;
      }

      // «/вход» у Издателя — войти в аккаунт клиента живым браузером (вариант C). Код подтверждения
      // спрашивается карточкой прямо здесь и принимается реплаем, поэтому чинить умершую сессию
      // можно из Telegram, не заходя на сервер по SSH. claude -p не зовётся.
      const loginCmd = identity.key === PUBLISHER_KEY ? parseLoginCommand(cmdText) : null;
      if (loginCmd) {
        if (loginCmd.action === 'status') {
          await replyChunked(ctx, await renderSessionStatus({ config }));
          return;
        }
        await ctx.reply('🔐 Захожу в аккаунт клиента… Если понадобится код — пришлю карточку сюда.', opts);
        const report = await runLoginFromTopic({
          bot: { api: ctx.api },
          chatId: ctx.chat.id,
          topicId: ctx.message.message_thread_id ?? null,
          config,
          log: (m) => console.log(`[login] ${m}`),
        });
        await replyChunked(ctx, report);
        return;
      }

      // «/рендер 12» у Дизайнера — перерисовать визуал элемента очереди, не дёргая агента.
      const renderId = identity.key === DESIGNER_KEY ? parseRenderCommand(cmdText) : null;
      if (renderId) {
        await handleRenderCommand(ctx, runtime, renderId);
        return;
      }
      // Голое «/render» — ровно то, что шлёт меню команд (аргументов оно не передаёт). Без этой ветки
      // оно ушло бы Дизайнеру задачей: платный вызов claude -p и, чего доброго, новый черновик в очередь.
      if (identity.key === DESIGNER_KEY && /^\/(рендер|render)\s*$/iu.test(cmdText)) {
        await replyChunked(ctx, 'ℹ️ Нужен номер черновика: «/рендер 12» перерисует визуал #12. Номера — в «/очередь» у Издателя.');
        return;
      }

      // «/тренды» у Разведчика — сбор постов через Apify и разбор их в темы (T09).
      const trends = identity.key === SCOUT_KEY ? parseTrendsCommand(cmdText) : null;
      if (trends) {
        await handleTrendsCommand(ctx, runtime, trends);
        return;
      }

      // «/пдф» у Презентатора — собрать PDF-лид-магниты инста-воронки (T13).
      const pdfCmd = identity.key === PRESENTER_KEY ? parsePdfCommand(cmdText) : null;
      if (pdfCmd) {
        await handlePdfCommand(ctx, runtime, pdfCmd);
        return;
      }

      // «/воронка» у Презентатора — состояние инста-воронки и её синхронизация с ManyChat (T14).
      const funnelCmd = identity.key === PRESENTER_KEY ? parseFunnelCommand(cmdText) : null;
      if (funnelCmd) {
        await handleFunnelCommand(ctx, runtime, funnelCmd);
        return;
      }

      // «/видео» у бота Видео (T16) — заявки на монтаж. Он же отвечает на всё остальное подсказкой:
      // думать ему нечем и незачем, монтаж живёт на ноуте клиента.
      if (identity.key === VIDEO_KEY) {
        const videoCmd = parseVideoCommand(cmdText);
        await handleVideoCommand(ctx, runtime, videoCmd ?? { action: 'help' });
        return;
      }

      // «Мозг бренда» (T18): любой текст — это идея во «Входящие» (или команда). До produceReply
      // он доходить не должен: у бота agent:null, и сырой прогон через claude -p сжёг бы вызов впустую.
      if (brain) {
        await handleBrainText(ctx, brain);
        return;
      }

      // «/отчёт» у Аналитика (T16) — факты конвейера плюс выводы агента.
      const reportCmd = identity.key === ANALYST_KEY ? parseReportCommand(cmdText) : null;
      if (reportCmd) {
        await handleReportCommand(ctx, runtime, reportCmd);
        return;
      }

      // «/слот 12 2026-09-05 10:00» — заготовка контент-календаря: помечает, когда публиковать.
      // Само расписание публикации приедет в T08, здесь только слот у элемента очереди.
      const slot = identity.key === PUBLISHER_KEY ? parseSlotCommand(cmdText) : null;
      if (slot) {
        const ok = runtime.db.queue.setSlot(slot.id, slot.slotAt);
        const hint = slot.recognized
          ? ''
          : '\n⚠️ Время не распознано (нужен формат 2026-09-05 10:00) — как расписание не сработает, публикация уйдёт сразу по «Одобрить».';
        await replyChunked(
          ctx,
          ok ? `🗓 Слот для #${slot.id}: ${slot.slotAt}${hint}` : `⚠️ Черновик #${slot.id} не найден.`,
        );
        return;
      }

      // Правка реплаем на карточку: сообщение адресовано конкретному элементу очереди.
      const repliedTo = ctx.message.reply_to_message?.message_id;

      // Код подтверждения входа реплаем на карточку «пришлите код» (вариант C). Проверяется
      // ПЕРВЫМ: это поиск в памяти, он дешевле похода в БД за элементом очереди. И он не должен
      // попасть в claude -p — код подтверждения не задача для агента.
      if (identity.key === PUBLISHER_KEY && repliedTo && hasPendingCode(repliedTo)) {
        const res = submitCode(repliedTo, ctx.message.text);
        await ctx.reply(
          res === 'accepted'
            ? '🔐 Код принят, продолжаю вход…'
            : '⚠️ В сообщении нет цифр. Пришли код реплаем ещё раз — попытка входа ещё ждёт.',
          opts,
        );
        return;
      }

      if (identity.key === PUBLISHER_KEY && repliedTo) {
        const item = runtime.db.queue.getByCard(ctx.chat.id, repliedTo);
        if (item?.status === 'needs_edit') {
          await handleEditReply(ctx, runtime, item, ctx.message.text);
          return;
        }
      }

      await ctx.replyWithChatAction('typing', opts).catch(() => {});
      const { text, meta } = await produceReply(identity, ctx.message.text);
      await replyChunked(ctx, text);

      // План Продюсера разбираем на задачи и раздаём (T05). Ошибка раздачи не роняет ответ.
      if (identity.key === PRODUCER_KEY && meta) {
        await orchestrateProducerPlan(ctx, runtime, meta).catch((err) =>
          console.error('[producer] orchestration error:', err),
        );
      } else if (identity.agent && meta) {
        // Агента попросили напрямую в его топике: публикуемый черновик тоже идёт на согласование.
        await enqueueDirectDraft(ctx, runtime, identity, meta, text).catch((err) =>
          console.error(`[${identity.key}] enqueue error:`, err),
        );
      }
    } catch (err) {
      console.error(`[${identity.key}] handler error:`, err);
      await ctx.reply('⚠️ Внутренняя ошибка диспетчера — см. логи.').catch(() => {});
    }
  });

  bot.catch((err) => console.error(`[${identity.key}] bot error:`, err));
  return { identity, bot };
}

async function main() {
  const identities = enabledIdentities();
  if (identities.length === 0) {
    console.error('Нет ни одного бота с заданным токеном. Заполни dispatcher/.env (см. .env.example).');
    process.exit(1);
  }

  // Общее состояние процесса: БД (статусы задач) и реестр поднятых ботов по ключу агента.
  // botsByKey нужен оркестрации: Продюсер постит ТЗ в чужой топик, а результат туда же кладёт
  // бот-исполнитель — значит нужны оба соединения сразу (см. src/orchestrator.js).
  const runtime = { db: openDb(), botsByKey: new Map() };

  const bots = identities.map((identity) => buildBot(identity, runtime));
  for (const entry of bots) runtime.botsByKey.set(entry.identity.key, entry);
  console.log(`Запускаю ${bots.length} бот(ов): ${bots.map((b) => b.identity.key).join(', ')}`);
  logAccessPolicy(identities);

  // Отложенные по слоту публикации (T08). Основной путь — сразу по «Одобрить»; сюда попадает
  // только то, чему задан слот на будущее. Уведомление уходит в топик Издателя.
  const stopScheduler = startPublishScheduler({
    db: runtime.db,
    botsByKey: runtime.botsByKey,
    channelId: config.tgChannelId,
    onPublished: async (item, res) => {
      const seat = publisherSeat(runtime);
      if (!seat.bot || !config.forumGroupId || seat.topicId == null) return;
      const text =
        res.status === 'published'
          ? `📣 #${item.id} опубликован по слоту ${item.slot_at}.`
          : `⚠️ #${item.id} по слоту ${item.slot_at} не опубликован: ${res.error || res.reason}`;
      await postToTopic(seat.bot, config.forumGroupId, seat.topicId, text);
    },
  });
  if (!config.tgChannelId) {
    console.warn('TG_CHANNEL_ID не задан — публикация в канал работать не будет (см. .env.example).');
  }

  // Какие площадки реально настроены (TG — T08, Threads — T11, IG — T12). Ненастроенная площадка
  // не молчит: по «Одобрить» элемент уйдёт в publish_failed с причиной — но лучше увидеть это сразу.
  for (const p of platformStatuses({ config, botsByKey: runtime.botsByKey, channelId: config.tgChannelId })) {
    console.log(`  ${p.ok ? '✓' : '—'} публикация ${p.platform}${p.ok ? '' : `: ${p.error}`}`);
  }
  if (config.publishDryRun) {
    console.warn('PUBLISH_DRY_RUN=1 — в IG/Threads ничего не публикуется, только печатается план вызовов.');
  }

  // Суточный автосбор трендов (T09). Включается только при заданном TRENDS_AT; иначе сбор
  // делается вручную командой «/тренды» в топике Разведчика. Отчёт постит бот Разведчика.
  const stopTrends = startTrendsScheduler({
    db: runtime.db,
    config,
    onLog: (m) => console.log(m),
    onDone: async (res) => {
      const seat = runtime.botsByKey.get(SCOUT_KEY);
      if (!seat?.bot || !config.forumGroupId || seat.identity.topicId == null) return;
      await postToTopic(seat.bot, config.forumGroupId, seat.identity.topicId, res.report || res.summary);
    },
  });
  if (config.trendsAt) console.log(`Автосбор трендов включён на ${config.trendsAt} (провайдер: ${config.trendsProvider}).`);

  // Еженедельный отчёт Аналитика (T16). Включается ANALYTICS_AT; иначе отчёт собирается вручную
  // командой «/отчёт» в его топике. Один вызов claude -p на отчёт — не чаще раза в неделю.
  const stopAnalytics = startAnalyticsScheduler({
    db: runtime.db,
    config,
    onLog: (m) => console.log(m),
    onReport: async (res) => {
      const seat = runtime.botsByKey.get(ANALYST_KEY);
      if (!seat?.bot || !config.forumGroupId || seat.identity.topicId == null) return;
      await postToTopic(seat.bot, config.forumGroupId, seat.identity.topicId, renderReport(res));
    },
  });
  if (config.analyticsAt) {
    const day = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][config.analyticsWeekday] || config.analyticsWeekday;
    console.log(`Автоотчёт Аналитика включён: ${day} в ${config.analyticsAt}, за ${config.analyticsDays} дн.`);
  }

  // Корректная остановка по Ctrl+C / SIGTERM.
  const stopAll = () => {
    console.log('\nОстанавливаю ботов…');
    stopScheduler();
    stopTrends();
    stopAnalytics();
    Promise.allSettled(bots.map((b) => b.bot.stop())).finally(() => {
      runtime.db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);

  // bot.start() у grammY резолвится только на остановке — запускаем без await, параллельно.
  for (const { identity, bot } of bots) {
    bot.start({ onStart: () => console.log(`  ✓ ${identity.key} (${identity.title}) на связи`) });
  }
}

main();
