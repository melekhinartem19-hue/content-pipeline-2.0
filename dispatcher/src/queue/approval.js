// Согласование: постановка черновика в очередь, карточка в топике Издателя и обработка нажатий (T07).
//
// Разделение с card.js: там чистый рендер, здесь I/O — Telegram и БД. Правило «публикация только
// после ок» держится именно тут: статус меняется в БД в момент нажатия, а не в памяти процесса,
// поэтому решение переживает перезапуск, и T08 берёт на публикацию только `approved`.

import { renderCard, renderDecidedCard, approvalKeyboard, parseCallbackData, variantAction, DECISIONS } from './card.js';
import { platformForKind } from './kinds.js';
import { chosenVariant, needsVariantChoice, pickVariant, variantsOf } from './variants.js';
import { attachVisuals } from '../render/visuals.js';
import { isOwner } from '../bots/router.js';
import { config } from '../config.js';

/**
 * Кладёт черновик в очередь и вешает карточку с кнопками в топик Издателя.
 * @param {object} o
 * @param {object} o.db  фасад БД
 * @param {object} o.bot  бот Издателя (карточка должна быть его, чтобы он мог её редактировать)
 * @param {number|string} o.groupId  форум-группа
 * @param {number} o.topicId  топик Издателя
 * @param {object} o.draft  { platform, agent, kind, title, content, meta, taskId, parentId, editNote }
 * @returns {Promise<{id:number, messageId:number|null, error?:string}>}
 */
export async function enqueueDraft({ db, bot, groupId, topicId, draft }) {
  const id = db.queue.add({ ...draft, status: 'pending' });
  const item = db.queue.getById(id);

  // Карточку показать не удалось — элемент всё равно в очереди и найдётся через «/очередь».
  if (!bot || !groupId || topicId == null) {
    return { id, messageId: null, error: 'не задан топик Издателя (TOPIC_PUBLISHER) или FORUM_GROUP_ID' };
  }

  const msg = await bot.api.sendMessage(groupId, renderCard(item), {
    message_thread_id: topicId,
    reply_markup: approvalKeyboard(item),
  });
  db.queue.attachCard(id, { chatId: groupId, messageId: msg.message_id });
  return { id, messageId: msg.message_id };
}

/**
 * Единая точка приёма ответа агента в очередь: и для авто-раздачи Продюсера (T05), и для прямого
 * обращения к агенту в его топике. Решает `kind` из META — план, отчёт по трендам и проверка
 * Издателя согласования не требуют (см. kinds.js).
 *
 * Здесь же врезан рендер визуала (T10): спецификация Дизайнера превращается в картинки ДО того,
 * как появится карточка, — владелец согласовывает готовый визуал, а не его словесное описание.
 * Для остальных видов контента шаг холостой. Неудача рендера черновик не теряет: он всё равно
 * встаёт в очередь, а причина возвращается вызывающему в `visualError`.
 *
 * @returns {Promise<{enqueued:boolean, id?:number, error?:string, reason?:string,
 *   images?:string[], visualNote?:string|null, visualError?:string|null}>}
 */
export async function enqueueAgentResult({
  db,
  agent,
  meta,
  content,
  taskId = null,
  botsByKey,
  groupId,
  publisherKey = 'publisher',
  visualizer = attachVisuals,
}) {
  const platform = platformForKind(meta?.kind);
  if (!platform) return { enqueued: false, reason: 'ответ агента не является публикуемым контентом' };

  const visuals = await visualizer({ agent, meta, content, botsByKey, groupId, publisherKey });

  const publisher = botsByKey?.get(publisherKey);
  const { id, error } = await enqueueDraft({
    db,
    bot: publisher?.bot,
    groupId,
    topicId: publisher?.identity?.topicId ?? null,
    draft: {
      platform,
      agent,
      kind: meta.kind,
      title: typeof meta.title === 'string' ? meta.title : null,
      content,
      // meta уже с путями к картинкам, если рендер был: их читают публикация (T08/T12) и PDF (T13).
      meta: visuals.meta,
      taskId,
    },
  });
  return {
    enqueued: true,
    id,
    error,
    images: visuals.files,
    visualNote: visuals.note,
    visualError: visuals.error,
  };
}

/**
 * Применяет решение к элементу очереди. Чистая логика поверх БД — без Telegram, поэтому
 * проверяется оффлайн. Повторное нажатие по уже решённой карточке не перезаписывает решение.
 * @returns {{ok:boolean, item?:object, note?:string, error?:string}}
 */
export function applyDecision({ db, id, action, by = null }) {
  const decision = DECISIONS[action];
  if (!decision) return { ok: false, error: 'неизвестная кнопка' };

  const item = db.queue.getById(id);
  if (!item) return { ok: false, error: `черновик #${id} не найден` };
  if (item.status !== 'pending') {
    return { ok: false, item, error: `по #${id} решение уже принято (${item.status})` };
  }

  // Одобрить черновик с несколькими вариантами, не выбрав один, нельзя: в канал уехали бы все
  // варианты сразу вместе с разделителями «=== ВАРИАНТ N ===». Отклонить и отправить на правку
  // можно как есть — там выбор не нужен.
  if (action === 'ok' && needsVariantChoice(item)) {
    const n = variantsOf(item).length;
    return { ok: false, item, error: `сначала выбери вариант (кнопки «Вариант 1»…«Вариант ${n}»)` };
  }

  db.queue.decide(id, decision.status, { by });
  return { ok: true, item: db.queue.getById(id), note: decision.done };
}

/**
 * Выбор варианта поста (кнопка «Вариант N»). Решением НЕ является: статус остаётся `pending`,
 * меняется содержимое черновика — в нём остаётся ровно выбранный текст, и именно он уйдёт в
 * канал по «Одобрить». Передумать можно до самого решения: исходный ответ агента лежит в
 * `meta.variants_source`.
 * @returns {{ok:boolean, item?:object, note?:string, error?:string}}
 */
export function applyVariantChoice({ db, id, n }) {
  const item = db.queue.getById(id);
  if (!item) return { ok: false, error: `черновик #${id} не найден` };
  if (item.status !== 'pending') {
    return { ok: false, item, error: `по #${id} решение уже принято (${item.status}) — вариант не сменить` };
  }

  const variant = pickVariant(item, n);
  if (!variant) return { ok: false, item, error: `у #${id} нет варианта ${n}` };
  if (!variant.text) return { ok: false, item, error: `вариант ${n} пустой — публиковать нечего` };
  if (chosenVariant(item) === variant.n) {
    return { ok: true, item, note: `Вариант ${variant.n} уже выбран`, unchanged: true };
  }

  // Исходный ответ агента сохраняем ОДИН раз: после первой замены content — это уже один вариант.
  const meta = { ...(item.meta || {}) };
  if (!meta.variants_source) meta.variants_source = item.content;
  meta.variant_choice = variant.n;
  meta.variant_angle = variant.angle || null;

  db.queue.setMeta(id, meta);
  db.queue.setContent(id, variant.text);
  return { ok: true, item: db.queue.getById(id), note: `Выбран вариант ${variant.n}` };
}

/**
 * Вешает на бота Издателя обработчик нажатий. Кнопки живут в callback_data (`q:<действие>:<id>`),
 * состояние — в БД, поэтому после перезапуска процесса старые карточки продолжают работать.
 * @param {object} bot  бот Издателя
 * @param {object} runtime  { db, botsByKey } — общее состояние процесса (см. src/index.js)
 * @param {object} [hooks]
 * @param {Function} [hooks.onApproved]  «нажали Одобрить» → публикация в канал (T08)
 * @param {Function} [hooks.onNeedsEdit]  «нажали Правку». В диспетчере цикл доработки замкнут иначе —
 *   через реплай владельца на карточку (см. src/queue/rework.js), поэтому хук нужен тестам
 *   и будущим сценариям.
 * @param {Set<number>} [hooks.ownerIds]  кто вправе нажимать кнопки (default: OWNER_IDS из конфига).
 */
export function registerApprovalHandlers(
  bot,
  runtime,
  { onApproved = null, onNeedsEdit = null, ownerIds = config.ownerIds } = {},
) {
  bot.on('callback_query:data', async (ctx) => {
    const parsed = parseCallbackData(ctx.callbackQuery.data);
    if (!parsed) return; // не наша кнопка — молча мимо

    // Тот же allowlist, что и для текста. Карточка висит в группе, а нажать кнопку может ЛЮБОЙ её
    // участник — включая случайно добавленного человека. Отвечаем через answerCallbackQuery,
    // иначе у нажавшего кнопка «залипает» в состоянии загрузки.
    if (!isOwner(ctx, ownerIds)) {
      await ctx.answerCallbackQuery({ text: '⛔ Нет доступа', show_alert: true }).catch(() => {});
      return;
    }

    const by = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? 'кто-то');

    // «Вариант N» — не решение: карточка остаётся живой, меняется только её содержимое и галочка
    // на кнопке. Поэтому обрабатывается отдельной веткой и не трогает статус.
    const variantNo = variantAction(parsed.action);
    if (variantNo !== null) {
      const picked = applyVariantChoice({ db: runtime.db, id: parsed.id, n: variantNo });
      if (!picked.ok) {
        await ctx.answerCallbackQuery({ text: `⚠️ ${picked.error}`, show_alert: true }).catch(() => {});
        return;
      }
      if (!picked.unchanged) {
        await ctx
          .editMessageText(renderCard(picked.item), { reply_markup: approvalKeyboard(picked.item) })
          .catch((err) => console.error('[publisher] не удалось обновить карточку:', err.message));
      }
      await ctx.answerCallbackQuery({ text: picked.note }).catch(() => {});
      return;
    }

    const res = applyDecision({ db: runtime.db, id: parsed.id, action: parsed.action, by });

    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: `⚠️ ${res.error}`, show_alert: true }).catch(() => {});
      return;
    }

    // Карточка редактируется на месте: кнопки снимаются, в подвале — кто и что решил.
    await ctx
      .editMessageText(renderDecidedCard(res.item, { decision: parsed.action, by }), { reply_markup: undefined })
      .catch((err) => console.error('[publisher] не удалось обновить карточку:', err.message));
    await ctx.answerCallbackQuery({ text: res.note }).catch(() => {});

    if (parsed.action === 'ed' && onNeedsEdit) {
      await onNeedsEdit(ctx, res.item).catch((err) => console.error('[publisher] правка:', err));
    }
    if (parsed.action === 'ok' && onApproved) {
      await onApproved(ctx, res.item).catch((err) => console.error('[publisher] публикация:', err));
    }
  });
}
