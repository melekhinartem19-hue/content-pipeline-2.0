// Карточка согласования (T07): как элемент очереди выглядит в Telegram и как читаются кнопки.
//
// Здесь ТОЛЬКО чистые функции — ни Telegram, ни БД. I/O живёт в approval.js, поэтому карточку
// можно проверять оффлайн (scripts/smoke-card.mjs).
//
// Все карточки висят в топике Издателя: одна лента согласования на весь конвейер, чтобы владельцу
// не приходилось обходить топики агентов в поисках «что ждёт решения».

import { chosenVariant, variantsOf } from './variants.js';

/** Сколько символов черновика влезает в карточку (лимит сообщения 4096 минус шапка и подвал). */
export const CARD_CONTENT_LIMIT = 3000;

/** Префикс callback_data. Формат `q:<действие>:<id>` — влезает в лимит 64 байта Telegram. */
const CB_PREFIX = 'q';

/** Кнопка → статус, в который переходит элемент очереди. */
export const DECISIONS = {
  ok: { action: 'ok', label: '✅ Одобрить', status: 'approved', done: 'Одобрено' },
  no: { action: 'no', label: '❌ Отклонить', status: 'rejected', done: 'Отклонено' },
  ed: { action: 'ed', label: '✏️ Правка', status: 'needs_edit', done: 'Отправлено на правку' },
};

const STATUS_LABEL = {
  draft: '📝 черновик',
  pending: '⏳ ждёт решения',
  approved: '✅ одобрено',
  rejected: '❌ отклонено',
  needs_edit: '✏️ на правке',
  superseded: '🗂 заменено новой версией',
  published: '📣 опубликовано',
};

/** Человеческие имена агентов — в карточке видно, кто автор черновика. */
const AGENT_TITLE = {
  video: 'Видео', // монтаж на ноуте клиента (T15): бота на VPS у него нет, а автор в карточке нужен
  writer: 'Сценарист',
  designer: 'Дизайнер',
  scout: 'Разведчик',
  presenter: 'Презентатор',
  publisher: 'Издатель',
  producer: 'Продюсер',
};

export function buildCallbackData(action, id) {
  return `${CB_PREFIX}:${action}:${id}`;
}

/**
 * Разбирает callback_data кнопки. Чужие/битые данные → null (карточка не наша, молча мимо).
 * Действие `v3` — «выбрать вариант 3»: оно не меняет статус, а переписывает содержимое черновика.
 */
export function parseCallbackData(data) {
  const m = /^q:(ok|no|ed|v\d{1,2}):(\d+)$/.exec(String(data || ''));
  return m ? { action: m[1], id: Number(m[2]) } : null;
}

/** Номер варианта из действия (`v2` → 2) или null, если это обычная кнопка решения. */
export function variantAction(action) {
  const m = /^v(\d{1,2})$/.exec(String(action || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Клавиатура карточки. id зашит в callback_data → после перезапуска кнопки живые.
 * Если у черновика несколько вариантов (Сценарист прислал 2–3 поста в одном ответе), сверху
 * появляется ряд «Вариант N» — выбранный помечается галочкой. Без выбора «Одобрить» не сработает:
 * иначе в канал уехали бы все варианты сразу вместе с разделителями.
 * @param {object|number} itemOrId  элемент очереди (обычный случай) или просто id
 */
export function approvalKeyboard(itemOrId) {
  const item = itemOrId && typeof itemOrId === 'object' ? itemOrId : { id: Number(itemOrId) };
  const id = item.id;
  const rows = [];

  const variants = variantsOf(item);
  if (variants.length >= 2) {
    const chosen = chosenVariant(item);
    const buttons = variants.map((v) => ({
      text: `${v.n === chosen ? '✓ ' : ''}Вариант ${v.n}`,
      callback_data: buildCallbackData(`v${v.n}`, id),
    }));
    // По 3 кнопки в ряд: длинный ряд Telegram сожмёт до нечитаемых огрызков.
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  }

  rows.push([
    { text: DECISIONS.ok.label, callback_data: buildCallbackData('ok', id) },
    { text: DECISIONS.no.label, callback_data: buildCallbackData('no', id) },
    { text: DECISIONS.ed.label, callback_data: buildCallbackData('ed', id) },
  ]);
  return { inline_keyboard: rows };
}

/** Текст карточки: шапка «что это и от кого» + сам черновик (обрезанный до лимита). */
export function renderCard(item) {
  const agent = AGENT_TITLE[item.agent] || item.agent;
  const head = `🗂 Черновик #${item.id} · ${agent} · ${item.kind} → ${item.platform}`;
  const lines = [head];
  if (item.title) lines.push(`Тема: ${item.title}`);
  if (item.parent_id) lines.push(`Версия после правки #${item.parent_id}: ${item.edit_note || '—'}`);
  // Картинки (T10) уходят в топик Издателя отдельным альбомом прямо перед карточкой — здесь
  // только строка-указатель, чтобы по одной карточке было видно, есть ли у черновика визуал.
  const n = imageCount(item);
  if (n) lines.push(`🖼 Картинок: ${n} — альбом над этой карточкой`);
  // Ролик с ноута клиента (T15) в карточку не вложить: сюда он и не приезжает файлом, а лежит
  // в публичной статике. Владельцу нужна ссылка — посмотреть ролик до того, как жать «Одобрить».
  const video = videoUrl(item);
  if (video) lines.push(`🎬 Ролик: ${video}`);

  // Черновик с несколькими вариантами показывается целиком, пока владелец не выбрал один:
  // выбирать вслепую по «углам» нельзя, тексты надо видеть.
  const variants = variantsOf(item);
  const chosen = chosenVariant(item);
  if (variants.length >= 2 && chosen === null) {
    lines.push(`🔀 Вариантов: ${variants.length} — выбери кнопкой ниже, какой публиковать`);
    lines.push('', renderVariants(variants));
    return lines.join('\n');
  }
  if (variants.length >= 2) {
    lines.push(`🔀 Выбран вариант ${chosen} из ${variants.length} — сменить можно кнопкой ниже`);
  }

  lines.push('', truncate(item.content));
  return lines.join('\n');
}

/** Все варианты в одной карточке: лимит делится между ними поровну. */
function renderVariants(variants, limit = CARD_CONTENT_LIMIT) {
  const per = Math.max(200, Math.floor(limit / variants.length) - 40);
  return variants
    .map((v) => `── Вариант ${v.n}${v.angle ? `: ${v.angle}` : ''} ──\n${truncate(v.text, per)}`)
    .join('\n\n');
}

/** Сколько картинок отрендерено к этому элементу очереди (0 — визуала нет). */
export function imageCount(item) {
  return Array.isArray(item?.meta?.images) ? item.meta.images.length : 0;
}

/** Публичная ссылка на готовый ролик (T15) или null, если у элемента видео нет. */
export function videoUrl(item) {
  const url = item?.meta?.video_url;
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/** Карточка после решения: тот же текст + подвал «кто и что решил». Кнопки при этом снимаются. */
export function renderDecidedCard(item, { decision, by = null }) {
  const d = DECISIONS[decision] || null;
  const label = d ? d.done : STATUS_LABEL[item.status] || item.status;
  const who = by ? ` — ${by}` : '';
  const hint = decision === 'ed' ? '\nНапиши правку ответом (реплаем) на эту карточку.' : '';
  return `${renderCard(item)}\n\n─────\n${label}${who}${hint}`;
}

/** Список ожидающих решения — ответ на «/очередь» в топике Издателя. */
export function renderQueueList(items, counts = {}) {
  if (!items.length) return '📋 Очередь пуста — черновиков на согласовании нет.';
  const head = Object.entries(counts)
    .map(([status, n]) => `${STATUS_LABEL[status] || status}: ${n}`)
    .join(' · ');
  const lines = [`📋 Ждут решения (${items.length}). Всего в очереди — ${head}`, ''];
  for (const it of items) {
    const agent = AGENT_TITLE[it.agent] || it.agent;
    const pics = imageCount(it) ? ` 🖼${imageCount(it)}` : '';
    const film = videoUrl(it) ? ' 🎬' : '';
    lines.push(`⏳ #${it.id} · ${agent} · ${it.platform}${pics}${film}: ${firstLine(it.title || it.content)}`);
  }
  return lines.join('\n');
}

/** Распознаёт «/очередь» («/queue», «очередь») — отвечаем из БД, без claude -p. */
export function isQueueCommand(text) {
  // Граница слова через (?![\p{L}\p{N}_]) с флагом u: \b не считает кириллицу за букву.
  return /^\/?(очередь|queue)(?![\p{L}\p{N}_])/iu.test(String(text || '').trim());
}

/**
 * Разбирает «/слот 12 2026-09-05 10:00» → { id: 12, slotAt: '2026-09-05 10:00' }.
 * Заготовка контент-календаря: сам момент публикации по слоту приедет в T08, здесь только
 * отметка «когда планируем». Время не парсим и не валидируем — храним строкой как задал владелец.
 */
export function parseSlotCommand(text) {
  const m = /^\/?(слот|slot)\s+#?(\d+)\s+(\S.*)$/iu.exec(String(text || '').trim());
  if (!m) return null;
  const raw = m[3].trim();
  return { id: Number(m[2]), slotAt: normalizeSlot(raw) ?? raw, recognized: normalizeSlot(raw) !== null };
}

/**
 * Приводит «2026-09-05 10:00» / «2026-09-05T10:00» к единому виду `YYYY-MM-DD HH:MM`.
 * В этом формате слоты можно сравнивать как строки — на нём и держится планировщик (T08).
 * Свободный текст («завтра в 10») не распознаётся: он сохранится как пометка, но расписанием
 * считаться не будет — публикация уйдёт сразу по «Одобрить».
 */
export function normalizeSlot(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(input || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null;
}

function truncate(text, limit = CARD_CONTENT_LIMIT) {
  const s = String(text || '').trim();
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n\n…текст обрезан для карточки; полный черновик — в топике автора.`;
}

function firstLine(text, max = 70) {
  const line = String(text || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
