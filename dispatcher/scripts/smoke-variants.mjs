// Смоук-тест выбора варианта поста на карточке согласования (доработка T07).
//
// Проверяет главное правило: черновик с несколькими вариантами НЕ публикуется целиком. Владелец
// жмёт «Вариант N», в элементе очереди остаётся ровно этот текст, и он же уходит в канал.
// Оффлайн: Telegram и claude -p подменены. Запуск: node dispatcher/scripts/smoke-variants.mjs
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { approvalKeyboard, buildCallbackData, parseCallbackData, renderCard, variantAction } from '../src/queue/card.js';
import { applyDecision, applyVariantChoice, enqueueDraft, registerApprovalHandlers } from '../src/queue/approval.js';
import { chosenVariant, hasVariants, needsVariantChoice, splitVariants, variantsOf } from '../src/queue/variants.js';
import { publishItem } from '../src/publish/index.js';

const THREE = [
  '=== ВАРИАНТ 1: про боль ===',
  'Текст первого поста. Он про боль клиента.',
  '',
  '=== ВАРИАНТ 2: про экономию ===',
  'Текст второго поста. Он про деньги и экономию.',
  '',
  '=== ВАРИАНТ 3: про скорость ===',
  'Текст третьего поста. Он про скорость.',
].join('\n');

// ── Разбор вариантов ──────────────────────────────────────────────────────
const parsed = splitVariants(THREE);
assert.equal(parsed.length, 3, 'три варианта распознаны');
assert.deepEqual(parsed.map((v) => v.n), [1, 2, 3], 'номера взяты из разделителей');
assert.equal(parsed[1].angle, 'про экономию', 'угол вытащен из разделителя');
assert.equal(parsed[1].text, 'Текст второго поста. Он про деньги и экономию.', 'текст варианта — до следующего разделителя');
assert.ok(!parsed[2].text.includes('==='), 'разделители в текст не попадают');

assert.equal(splitVariants('Просто пост без разделителей').length, 0, 'обычный пост вариантов не имеет');
assert.equal(splitVariants('=== ВАРИАНТ 1: один ===\nтекст').length, 0, 'один блок — выбирать не из чего');
assert.equal(splitVariants(null).length, 0, 'пустой вход не роняет разбор');
assert.equal(
  splitVariants('Вот варианты:\n=== вариант 1 ===\nа\n=== Вариант 2 ===\nб').length,
  2,
  'регистр и отсутствие угла не мешают; преамбула отбрасывается',
);

// ── Кнопки ────────────────────────────────────────────────────────────────
assert.deepEqual(parseCallbackData('q:v2:12'), { action: 'v2', id: 12 }, 'кнопка варианта разбирается');
assert.equal(variantAction('v3'), 3, 'номер варианта из действия');
assert.equal(variantAction('ok'), null, 'обычная кнопка вариантом не считается');
assert.equal(parseCallbackData('q:v99999:1'), null, 'мусорное действие отсекается');
assert.ok(buildCallbackData('v3', 12345).length <= 64, 'callback_data влезает в лимит Telegram');

// ── Карточка и клавиатура ─────────────────────────────────────────────────
const db = openDb(':memory:');
const cards = [];
const publisherBot = {
  api: {
    sendMessage: async (chat, text, opts) => {
      cards.push({ chat, text, opts });
      return { message_id: 500 + cards.length };
    },
  },
};

const { id } = await enqueueDraft({
  db,
  bot: publisherBot,
  groupId: -100123,
  topicId: 19,
  draft: { platform: 'tg', agent: 'writer', kind: 'tg_post', title: 'Тема', content: THREE },
});
const item = db.queue.getById(id);

assert.ok(hasVariants(item), 'у черновика есть варианты');
assert.ok(needsVariantChoice(item), 'и выбор ещё не сделан');
assert.equal(chosenVariant(item), null, 'выбранного варианта нет');

const card = renderCard(item);
assert.match(card, /🔀 Вариантов: 3/, 'в карточке сказано, что вариантов несколько');
assert.match(card, /── Вариант 2: про экономию ──/, 'варианты показаны с углами');
assert.match(card, /Текст третьего поста/, 'тексты видно — выбирать вслепую не приходится');
assert.ok(renderCard(item).length < 4096, 'карточка с тремя вариантами влезает в лимит Telegram');

const kb = approvalKeyboard(item);
assert.equal(kb.inline_keyboard.length, 2, 'ряд вариантов + ряд решений');
assert.deepEqual(kb.inline_keyboard[0].map((b) => b.text), ['Вариант 1', 'Вариант 2', 'Вариант 3'], 'кнопка на вариант');
assert.equal(kb.inline_keyboard[0][1].callback_data, 'q:v2:1', 'в кнопке зашит номер варианта и id');
assert.equal(cards[0].opts.reply_markup.inline_keyboard.length, 2, 'карточка ушла в Telegram уже с кнопками вариантов');

const plain = db.queue.getById(
  db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'Обычный пост', status: 'pending' }),
);
assert.equal(approvalKeyboard(plain).inline_keyboard.length, 1, 'без вариантов лишних кнопок нет');
assert.equal(approvalKeyboard(7).inline_keyboard.length, 1, 'вызов по одному id (старый контракт) работает');

// ── Одобрить без выбора нельзя ────────────────────────────────────────────
const blocked = applyDecision({ db, id, action: 'ok' });
assert.equal(blocked.ok, false, 'одобрение без выбора варианта не проходит');
assert.match(blocked.error, /сначала выбери вариант/, 'сказано, что сделать');
assert.equal(db.queue.getById(id).status, 'pending', 'статус не изменился');

// Отклонить и отправить на правку можно без выбора — там вариант не нужен.
const forEdit = db.queue.getById(
  db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: THREE, status: 'pending' }),
);
assert.equal(applyDecision({ db, id: forEdit.id, action: 'ed' }).ok, true, '«Правка» доступна без выбора');
const forReject = db.queue.getById(
  db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: THREE, status: 'pending' }),
);
assert.equal(applyDecision({ db, id: forReject.id, action: 'no' }).ok, true, '«Отклонить» доступно без выбора');

// ── Выбор варианта ────────────────────────────────────────────────────────
const picked = applyVariantChoice({ db, id, n: 2 });
assert.equal(picked.ok, true, 'вариант выбран');
assert.equal(picked.note, 'Выбран вариант 2', 'ответ владельцу понятен');

const afterPick = db.queue.getById(id);
assert.equal(afterPick.content, 'Текст второго поста. Он про деньги и экономию.', 'в черновике остался ровно выбранный текст');
assert.equal(afterPick.status, 'pending', 'выбор варианта решением НЕ является');
assert.equal(chosenVariant(afterPick), 2, 'выбор записан в meta');
assert.equal(afterPick.meta.variant_angle, 'про экономию', 'угол сохранён — видно, что выбрали');
assert.ok(afterPick.meta.variants_source.includes('=== ВАРИАНТ 3'), 'исходный ответ агента сохранён целиком');
assert.equal(variantsOf(afterPick).length, 3, 'варианты по-прежнему доступны — можно передумать');
assert.ok(!needsVariantChoice(afterPick), 'выбор больше не требуется');

const pickedCard = renderCard(afterPick);
assert.match(pickedCard, /🔀 Выбран вариант 2 из 3/, 'в карточке видно, что выбрано');
assert.ok(!pickedCard.includes('Текст третьего поста'), 'остальные варианты с карточки убраны');
assert.equal(approvalKeyboard(afterPick).inline_keyboard[0][1].text, '✓ Вариант 2', 'выбранная кнопка помечена');

// Передумать можно до решения.
assert.equal(applyVariantChoice({ db, id, n: 3 }).ok, true, 'вариант можно сменить');
assert.equal(db.queue.getById(id).content, 'Текст третьего поста. Он про скорость.', 'содержимое сменилось на новый вариант');
assert.ok(db.queue.getById(id).meta.variants_source.includes('=== ВАРИАНТ 1'), 'исходник не затёрся вторым выбором');

const again = applyVariantChoice({ db, id, n: 3 });
assert.equal(again.unchanged, true, 'повторный выбор того же варианта помечен как «ничего не изменилось»');
assert.match(applyVariantChoice({ db, id, n: 9 }).error, /нет варианта 9/, 'несуществующий вариант — понятная ошибка');
assert.match(applyVariantChoice({ db, id: 9999, n: 1 }).error, /не найден/, 'чужой id не роняет');

// ── Полный путь через настоящий обработчик кнопок ─────────────────────────
let handler;
const fakeBot = { on: (_event, fn) => { handler = fn; } };
let approved = null;
registerApprovalHandlers(fakeBot, { db }, { onApproved: async (_ctx, it) => { approved = it; } });

const answers = [];
const edited = [];
const ctxFor = (data) => ({
  callbackQuery: { data },
  from: { id: 1, username: 'owner' },
  answerCallbackQuery: async (o) => answers.push(o),
  editMessageText: async (text, opts) => edited.push({ text, opts }),
});

const fresh = await enqueueDraft({
  db,
  bot: publisherBot,
  groupId: -100123,
  topicId: 19,
  draft: { platform: 'tg', agent: 'writer', kind: 'tg_post', content: THREE },
});

await handler(ctxFor(buildCallbackData('ok', fresh.id)));
assert.match(answers.at(-1).text, /сначала выбери вариант/, 'кнопка «Одобрить» объясняет, чего не хватает');
assert.equal(db.queue.getById(fresh.id).status, 'pending', 'ничего не одобрено');

await handler(ctxFor(buildCallbackData('v1', fresh.id)));
assert.match(answers.at(-1).text, /Выбран вариант 1/, 'выбор подтверждён');
assert.match(edited.at(-1).text, /Выбран вариант 1 из 3/, 'карточка переписана');
assert.equal(edited.at(-1).opts.reply_markup.inline_keyboard.length, 2, 'кнопки остались — решение ещё впереди');

await handler(ctxFor(buildCallbackData('ok', fresh.id)));
assert.equal(db.queue.getById(fresh.id).status, 'approved', 'после выбора одобрение проходит');
assert.equal(approved.content, 'Текст первого поста. Он про боль клиента.', 'в публикацию ушёл выбранный вариант');
assert.equal(edited.at(-1).opts.reply_markup, undefined, 'после решения кнопки сняты');

// После решения вариант уже не сменить.
await handler(ctxFor(buildCallbackData('v2', fresh.id)));
assert.match(answers.at(-1).text, /решение уже принято/, 'выбор после одобрения заблокирован');

// ── В канал уходит один вариант, а не все три ─────────────────────────────
const posted = [];
const channelBot = {
  api: {
    sendMessage: async (chat, text) => {
      posted.push(text);
      return { message_id: 77 };
    },
  },
};
const res = await publishItem({
  db,
  item: db.queue.getById(fresh.id),
  botsByKey: new Map([['publisher', { bot: channelBot, identity: { key: 'publisher' } }]]),
  channelId: '@test',
});
assert.equal(res.status, 'published', 'публикация прошла');
assert.equal(posted.length, 1, 'в канал ушло одно сообщение');
assert.equal(posted[0], 'Текст первого поста. Он про боль клиента.', 'в канале ровно выбранный вариант');
assert.ok(!posted[0].includes('ВАРИАНТ'), 'служебные разделители в канал не попали');

db.close();
console.log('✓ smoke-variants PASS — выбор варианта на карточке, защита «Одобрить» и публикация одного поста');
