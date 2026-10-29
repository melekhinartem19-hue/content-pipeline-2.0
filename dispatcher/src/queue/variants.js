// Варианты поста внутри одного черновика (T07-доработка).
//
// ЗАЧЕМ ЭТО ЕСТЬ. Сценарист отдаёт 2–3 варианта поста в ОДНОМ ответе, разделённых строкой
// `=== ВАРИАНТ N: угол ===`, и весь ответ целиком становится одним элементом очереди. Пока выбора
// не было, «Одобрить» публиковало в канал ВСЕ варианты сразу — вместе с разделителями. Теперь
// владелец сначала жмёт «Вариант N», и в канал уходит ровно он.
//
// Здесь только чистые функции разбора — ни Telegram, ни БД (I/O в approval.js), поэтому всё
// проверяется оффлайн.
//
// Разделитель обязан совпадать с контрактом из agents/writer.md. Меняешь его там — меняй здесь.

/** Строка-разделитель варианта: `=== ВАРИАНТ 2: про экономию ===` (угол необязателен). */
const VARIANT_RE = /^===\s*ВАРИАНТ\s*(\d+)\s*(?::\s*(.*?))?\s*===\s*$/gimu;

/** Минимум блоков, при котором есть из чего выбирать. */
const MIN_VARIANTS = 2;

/**
 * Режет текст черновика на варианты.
 * @param {string} content
 * @returns {{n:number, angle:string|null, text:string}[]}  пустой массив, если вариантов нет
 */
export function splitVariants(content) {
  const src = String(content || '');
  const marks = [];
  VARIANT_RE.lastIndex = 0;
  for (let m = VARIANT_RE.exec(src); m; m = VARIANT_RE.exec(src)) {
    marks.push({ n: Number(m[1]), angle: (m[2] || '').trim() || null, start: m.index, end: VARIANT_RE.lastIndex });
  }
  if (marks.length < MIN_VARIANTS) return [];

  return marks.map((mark, i) => ({
    n: mark.n,
    angle: mark.angle,
    // Текст варианта — всё до следующего разделителя (или до конца ответа у последнего).
    text: src.slice(mark.end, i + 1 < marks.length ? marks[i + 1].start : src.length).trim(),
  }));
}

/**
 * Варианты элемента очереди. После выбора `content` — уже один вариант, поэтому исходный ответ
 * агента хранится в `meta.variants_source`: по нему можно передумать и выбрать другой.
 */
export function variantsOf(item) {
  return splitVariants(item?.meta?.variants_source ?? item?.content);
}

/** Есть ли из чего выбирать (2+ варианта). */
export function hasVariants(item) {
  return variantsOf(item).length >= MIN_VARIANTS;
}

/** Какой вариант уже выбран (номер) или null. */
export function chosenVariant(item) {
  const n = Number(item?.meta?.variant_choice);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Ждёт ли элемент выбора варианта: варианты есть, выбор ещё не сделан. */
export function needsVariantChoice(item) {
  return hasVariants(item) && chosenVariant(item) === null;
}

/** Один вариант по номеру (или undefined). */
export function pickVariant(item, n) {
  return variantsOf(item).find((v) => v.n === Number(n));
}
