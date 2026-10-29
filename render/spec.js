// Разбор спецификации Дизайнера в структуру слайдов (T10).
//
// Вход — ТЕКСТ, который агент-Дизайнер вернул через `claude -p` (см. agents/designer.md,
// раздел «Формат вывода»). Разделители там объявлены неизменными именно ради этого модуля:
//
//     === СЛАЙД 1 ===        (карусель, слайдов много)
//     Заголовок: …
//     Текст: …
//     Визуал: …
//
//     === ОБЛОЖКА ===        (один кадр)
//
// Здесь ТОЛЬКО чистые функции — ни браузера, ни файлов, ни сети. Поэтому парсер проверяется
// оффлайн (dispatcher/scripts/smoke-render.mjs) и не зависит от того, установлен ли Chromium.
//
// Ответ языковой модели — не протокол: агент может добавить резюме сверху, забыть поле или
// съехать с формата. Парсер к этому терпим: чего нет — то null, лишнее до первого разделителя
// уходит в `summary`, а полностью неразобранный текст даёт слайды = [] (вызывающий покажет
// честную ошибку, а не пустые картинки).

/** Разделитель блока слайда. Число в «СЛАЙД N» необязательно — нумеруем по факту порядка. */
const SEP = /^[ \t]*=== *(?:СЛАЙД|SLIDE)[ \t]*(\d+)? *===[ \t]*$/gim;

/** Разделитель одиночного кадра-обложки. */
const SEP_COVER = /^[ \t]*=== *(?:ОБЛОЖКА|COVER) *===[ \t]*$/gim;

/** Поля внутри блока. Значение поля тянется до следующего поля или до конца блока. */
const FIELDS = [
  { key: 'title', re: /^[ \t]*(?:Заголовок|Title)[ \t]*:/i },
  { key: 'text', re: /^[ \t]*(?:Текст|Text)[ \t]*:/i },
  { key: 'visual', re: /^[ \t]*(?:Визуал|Visual)[ \t]*:/i },
];

/**
 * Разбирает ответ Дизайнера на слайды.
 * @param {string} raw  текст ответа агента (уже без META-конверта — его снял agent.js)
 * @param {object} [o]
 * @param {string} [o.kind]  kind из META: carousel_spec | cover_spec. Подсказка, не приказ:
 *   если разделители говорят другое, верим разделителям.
 * @returns {{format:'carousel'|'cover', summary:string, slides:{n:number, role:string,
 *   title:string|null, text:string|null, visual:string|null}[]}}
 */
export function parseDesignSpec(raw, { kind = null } = {}) {
  const text = String(raw || '').replace(/\r\n/g, '\n');

  const blocks = splitBlocks(text);
  const format = blocks.kindFromSeparators || (kind === 'cover_spec' ? 'cover' : 'carousel');

  const slides = blocks.parts.map((part, i) => {
    const fields = parseFields(part.body);
    return {
      n: i + 1,
      role: null, // проставляется ниже, когда известно общее число слайдов
      title: fields.title,
      text: fields.text,
      visual: fields.visual,
    };
  });

  assignRoles(slides, format);
  return { format, summary: blocks.summary, slides };
}

/**
 * Роль слайда решает, как он выглядит: обложка-хук крупная, финал — с акцентной плашкой.
 * Правило простое и предсказуемое: первый — cover, последний (если слайдов ≥ 3) — cta,
 * остальные — body. Для одиночной обложки роль всегда cover.
 */
function assignRoles(slides, format) {
  const last = slides.length - 1;
  slides.forEach((s, i) => {
    if (format === 'cover' || slides.length === 1) s.role = 'cover';
    else if (i === 0) s.role = 'cover';
    else if (i === last && slides.length >= 3) s.role = 'cta';
    else s.role = 'body';
  });
}

/** Режет текст на блоки по разделителям и отделяет вводное резюме агента. */
function splitBlocks(text) {
  const { summary, parts } = splitByMarks(text, [
    { re: SEP, kind: 'carousel' },
    { re: SEP_COVER, kind: 'cover' },
  ]);
  if (!parts.length) return { summary, parts, kindFromSeparators: null };

  // Смешанный ответ («=== ОБЛОЖКА ===» плюс слайды) считаем каруселью: кадров больше одного.
  const onlyCover = parts.length === 1 && parts[0].kind === 'cover';
  return { summary, parts, kindFromSeparators: onlyCover ? 'cover' : 'carousel' };
}

/**
 * Общий разрезатель текста агента на блоки — им пользуются и слайды (T10), и страницы PDF (T13).
 * Разделители у них разные («=== СЛАЙД N ===» против «=== СТРАНИЦА N ==='»), а логика одна:
 * всё до первого разделителя — вводное резюме агента, дальше блок тянется до следующего.
 *
 * @param {string} text  текст ответа агента (уже с \n)
 * @param {{re:RegExp, kind:string}[]} defs  глобальные (`g`) regexp разделителей
 * @returns {{summary:string, parts:{kind:string, body:string}[]}}
 */
export function splitByMarks(text, defs) {
  const marks = [];
  for (const { re, kind } of defs) {
    for (const m of text.matchAll(re)) marks.push({ index: m.index, len: m[0].length, kind });
  }
  marks.sort((a, b) => a.index - b.index);

  if (!marks.length) return { summary: text.trim(), parts: [] };

  const summary = text.slice(0, marks[0].index).trim();
  const parts = marks.map((mark, i) => {
    const from = mark.index + mark.len;
    const to = i + 1 < marks.length ? marks[i + 1].index : text.length;
    return { kind: mark.kind, body: text.slice(from, to) };
  });
  return { summary, parts };
}

/**
 * Достаёт поля из тела блока. Значение может занимать несколько строк — тянем до следующего
 * известного поля. Блок вообще без полей не выбрасываем: весь его текст становится `text`,
 * иначе «почти правильный» ответ агента дал бы пустой слайд.
 *
 * Экспортируется: у страниц PDF (T13) поля ровно те же (Заголовок/Текст/Визуал), и второй
 * разборщик полей означал бы два места, где «почти правильный» ответ агента чинится по-разному.
 */
export function parseFields(body) {
  const lines = body.split('\n');
  const out = { title: null, text: null, visual: null };
  let current = null;
  let buf = [];

  const flush = () => {
    if (current) out[current] = buf.join('\n').trim() || null;
    buf = [];
  };

  for (const line of lines) {
    const hit = FIELDS.find((f) => f.re.test(line));
    if (hit) {
      flush();
      current = hit.key;
      buf.push(line.replace(hit.re, '').trim());
      continue;
    }
    if (current) buf.push(line);
  }
  flush();

  if (!out.title && !out.text && !out.visual) {
    const plain = body.trim();
    if (plain) out.text = plain;
  }
  return out;
}

/**
 * Короткая человекочитаемая сводка разбора — уходит в топик рядом с картинками,
 * чтобы владелец видел, что именно отрендерилось, не открывая файлы.
 */
export function describeSpec(spec) {
  const kind = spec.format === 'cover' ? 'обложка' : `карусель, слайдов: ${spec.slides.length}`;
  const empty = spec.slides.filter((s) => !s.title && !s.text).length;
  const tail = empty ? ` · пустых блоков: ${empty}` : '';
  return `${kind}${tail}`;
}
