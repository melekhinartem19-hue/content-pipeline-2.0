// Смоук-тест карточки согласования (T07): рендер, кнопки, нажатия, идемпотентность.
// Оффлайн: вместо Telegram — фейковые bot.api и ctx. Запуск: node dispatcher/scripts/smoke-card.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import {
  CARD_CONTENT_LIMIT,
  approvalKeyboard,
  buildCallbackData,
  isQueueCommand,
  parseCallbackData,
  renderCard,
  renderDecidedCard,
  renderQueueList,
} from '../src/queue/card.js';
import { applyDecision, enqueueDraft, registerApprovalHandlers } from '../src/queue/approval.js';

// ── callback_data: свои кнопки читаем, чужие игнорируем ───────────────────
assert.equal(buildCallbackData('ok', 12), 'q:ok:12', 'формат callback_data');
assert.deepEqual(parseCallbackData('q:ed:7'), { action: 'ed', id: 7 }, 'разбор своей кнопки');
assert.equal(parseCallbackData('other:ok:1'), null, 'чужая кнопка → null');
assert.equal(parseCallbackData(undefined), null, 'пустые данные не роняют разбор');
assert.ok(buildCallbackData('ok', 999999).length < 64, 'влезаем в лимит callback_data');
assert.equal(approvalKeyboard(3).inline_keyboard[0].length, 3, 'три кнопки в ряд');

// ── Постановка в очередь + карточка в топике Издателя ─────────────────────
const db = openDb(':memory:');
const sent = [];
const edited = [];
const publisherBot = {
  api: {
    sendMessage: async (chatId, text, opts) => {
      sent.push({ chatId, text, opts });
      return { message_id: 500 + sent.length };
    },
  },
};

const { id, messageId } = await enqueueDraft({
  db,
  bot: publisherBot,
  groupId: -100123,
  topicId: 19,
  draft: { platform: 'tg', agent: 'writer', kind: 'tg_post', title: 'Тариф', content: '🚀 Текст поста' },
});
assert.equal(db.queue.getById(id).status, 'pending', 'черновик встал в очередь как pending');
assert.equal(sent[0].opts.message_thread_id, 19, 'карточка ушла в топик Издателя');
assert.ok(sent[0].opts.reply_markup.inline_keyboard, 'к карточке приложены кнопки');
assert.match(sent[0].text, /Черновик #1 · Сценарист · tg_post → tg/, 'в шапке — автор и площадка');
assert.equal(db.queue.getByCard(-100123, messageId).id, id, 'связь карточка↔элемент записана в БД');

// Карточка без бота/топика: элемент всё равно в очереди, но с честной ошибкой.
const noCard = await enqueueDraft({ db, bot: null, groupId: null, topicId: null, draft: { platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'x' } });
assert.equal(noCard.messageId, null, 'сообщения нет');
assert.match(noCard.error, /TOPIC_PUBLISHER/, 'сказано, чего не хватает');
assert.equal(db.queue.getById(noCard.id).status, 'pending', 'элемент не потерян');

// ── Длинный черновик обрезается, а не ломает отправку ─────────────────────
const long = await enqueueDraft({
  db,
  bot: publisherBot,
  groupId: -100123,
  topicId: 19,
  draft: { platform: 'tg', agent: 'designer', kind: 'carousel_spec', content: 'я'.repeat(5000) },
});
const longCard = renderCard(db.queue.getById(long.id));
assert.ok(longCard.length < 4096, 'карточка влезает в лимит сообщения Telegram');
assert.match(longCard, /текст обрезан для карточки/, 'обрезка помечена явно');
assert.ok(CARD_CONTENT_LIMIT < 4096, 'лимит контента оставляет место шапке');

// ── Нажатие кнопки через настоящий обработчик ─────────────────────────────
let handler;
const fakeBot = { on: (event, fn) => { assert.equal(event, 'callback_query:data'); handler = fn; } };
registerApprovalHandlers(fakeBot, { db });

const answers = [];
const ctxFor = (data) => ({
  callbackQuery: { data },
  from: { id: 1, username: 'owner' },
  answerCallbackQuery: async (o) => answers.push(o),
  editMessageText: async (text, opts) => edited.push({ text, opts }),
});

await handler(ctxFor(buildCallbackData('ok', id)));
assert.equal(db.queue.getById(id).status, 'approved', 'нажатие сменило статус в БД');
assert.equal(db.queue.getById(id).decided_by, '@owner', 'записано, кто нажал');
assert.match(edited[0].text, /Одобрено — @owner/, 'карточка переписана решением');
assert.equal(edited[0].opts.reply_markup, undefined, 'кнопки сняты');

// Повторное нажатие по решённой карточке решение не перезаписывает.
await handler(ctxFor(buildCallbackData('no', id)));
assert.equal(db.queue.getById(id).status, 'approved', 'статус не изменился');
assert.match(answers[1].text, /решение уже принято/, 'пользователю сказано, почему ничего не произошло');

// Кнопка по несуществующему элементу и чужая кнопка не роняют обработчик.
await handler(ctxFor(buildCallbackData('ok', 9999)));
assert.match(answers[2].text, /не найден/, 'понятная ошибка вместо падения');
await handler(ctxFor('foreign:data'));
assert.equal(answers.length, 3, 'чужая кнопка проигнорирована молча');

// Хуки решений: «Правка» зовёт доработку, «Одобрить» — публикацию (T08).
let editHook = null;
let approveHook = null;
registerApprovalHandlers(fakeBot, { db }, {
  onNeedsEdit: async (_ctx, item) => { editHook = item; },
  onApproved: async (_ctx, item) => { approveHook = item; },
});
await handler(ctxFor(buildCallbackData('ed', long.id)));
assert.equal(db.queue.getById(long.id).status, 'needs_edit', 'статус — на правке');
assert.equal(editHook.id, long.id, 'колбэк правки получил элемент очереди');
assert.match(edited.at(-1).text, /Напиши правку ответом/, 'в карточке подсказка, что делать дальше');

const toApprove = await enqueueDraft({
  db,
  bot: publisherBot,
  groupId: -100123,
  topicId: 19,
  draft: { platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'На публикацию' },
});
await handler(ctxFor(buildCallbackData('ok', toApprove.id)));
assert.equal(approveHook.id, toApprove.id, 'колбэк публикации получил одобренный элемент');
assert.equal(approveHook.status, 'approved', 'в колбэк приходит уже одобренный статус');

// ── applyDecision без Telegram + список очереди ───────────────────────────
assert.match(applyDecision({ db, id: 9999, action: 'ok' }).error, /не найден/, 'нет элемента → ошибка');
assert.match(applyDecision({ db, id, action: 'zz' }).error, /неизвестная кнопка/, 'чужое действие → ошибка');

const pending = db.queue.listPending();
const list = renderQueueList(pending, db.queue.countsByStatus());
assert.match(list, /Ждут решения/, 'список показывает ожидающих');
assert.equal(renderQueueList([]), '📋 Очередь пуста — черновиков на согласовании нет.', 'пустая очередь');
assert.ok(isQueueCommand('/очередь') && isQueueCommand('queue'), 'команда распознаётся');
assert.ok(!isQueueCommand('очередность важна'), 'обычный текст не перехватывается');

assert.match(renderDecidedCard(db.queue.getById(id), { decision: 'ok', by: '@owner' }), /─────/, 'подвал отделён');

db.close();
console.log('✓ smoke-card PASS — карточка, кнопки и решения работают, повторное нажатие безопасно');
