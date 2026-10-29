// Сборка PDF-лид-магнита: структура Презентатора → многостраничный PDF (T13).
//
// Вход — ТЕКСТ, который агент-Презентатор вернул через `claude -p` (см. agents/presenter.md,
// раздел «Формат вывода»). Разделители там объявлены неизменными именно ради этого модуля:
//
//     === СТРАНИЦА 1 ===
//     Заголовок: …
//     Текст: …
//     Визуал: …
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ СЛАЙДОВ (render/index.js). Слайд карусели — отдельная картинка 1080×1350,
// N файлов PNG. Страница PDF — часть ОДНОГО документа A4, и Chromium собирает его за один вызов
// `page.pdf()`: весь HTML со всеми страницами открывается разом, разрывы делает CSS
// (`page-break-after`). Поэтому здесь нет цикла по кадрам и нет N скриншотов.
//
// ПОЧЕМУ A4, А НЕ 4:5. Лид-магнит читают вне ленты — с экрана телефона, ноутбука, иногда печатают.
// A4 — то, чего человек ждёт от файла «скачать гайд»; вертикаль 1080×1350 в PDF читалась бы как
// «карусель, зачем-то склеенная в документ» (решение владельца 07.09.2026).
//
// Модуль такой же переносимый, как и весь render/: ни Telegram, ни БД, ни claude -p. На входе
// текст, на выходе файл.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFields, splitByMarks } from './spec.js';
import { loadTheme, NEUTRAL_THEME, fontStack, contrastOn } from './theme.js';
import { escapeHtml, pickMotif, motifSvg } from './html.js';
import { launchBrowser } from './browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DOC_TEMPLATE_PATH = path.join(__dirname, 'templates', 'pdf.html');
export const PAGE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'pdf-page.html');

/** Разделитель страницы. Номер необязателен — нумеруем по факту порядка, как и у слайдов. */
const SEP_PAGE = /^[ \t]*=== *(?:СТРАНИЦА|PAGE)[ \t]*(\d+)? *===[ \t]*$/gim;

/**
 * A4 в CSS-пикселях при 96 dpi: 210×297 мм = 8.27×11.69 дюйма. Верстаем в пикселях (как слайды),
 * а бумажный размер Chromium берёт из `@page { size: A4 }` — поэтому `preferCSSPageSize`.
 */
export const PAGE_SIZE = Object.freeze({ width: 794, height: 1123 });

/**
 * Потолок страниц. Презентатор проектирует обложку + 3–8 страниц раскрытия + финал, то есть
 * до ~10; 12 — запас, за которым начинается уже не лид-магнит, а брошюра. Хвост честно
 * отбрасываем и сообщаем об этом, а не молча теряем.
 */
export const MAX_PAGES = 12;

/**
 * Разбирает ответ Презентатора на страницы.
 * @param {string} raw  текст ответа агента (уже без META-конверта — его снял agent.js)
 * @returns {{format:'pdf', summary:string, pages:{n:number, role:string, title:string|null,
 *   text:string|null, visual:string|null}[]}}
 */
export function parsePdfSpec(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const { summary, parts } = splitByMarks(text, [{ re: SEP_PAGE, kind: 'page' }]);

  const pages = parts.map((part, i) => {
    const fields = parseFields(part.body);
    return { n: i + 1, role: 'body', title: fields.title, text: fields.text, visual: fields.visual };
  });

  // Драматургия документа из agents/presenter.md: обложка → раскрытие → финал с CTA.
  const last = pages.length - 1;
  pages.forEach((p, i) => {
    if (i === 0) p.role = 'cover';
    else if (i === last && pages.length >= 3) p.role = 'cta';
    else p.role = 'body';
  });

  return { format: 'pdf', summary, pages };
}

/** Короткая сводка разбора — уходит в топик рядом с файлом, чтобы не открывать PDF ради проверки. */
export function describePdfSpec(spec) {
  const empty = spec.pages.filter((p) => !p.title && !p.text).length;
  return `страниц: ${spec.pages.length}${empty ? ` · пустых блоков: ${empty}` : ''}`;
}

let templateCache = null;

/** Читает оба шаблона с диска (один раз за процесс). */
export async function loadPdfTemplates(docPath = DOC_TEMPLATE_PATH, pagePath = PAGE_TEMPLATE_PATH) {
  const isDefault = docPath === DOC_TEMPLATE_PATH && pagePath === PAGE_TEMPLATE_PATH;
  if (isDefault && templateCache) return templateCache;
  const [doc, rawPage] = await Promise.all([fsp.readFile(docPath, 'utf8'), fsp.readFile(pagePath, 'utf8')]);
  // Пояснение в начале pdf-page.html — для человека, а не для документа: иначе оно повторится
  // столько раз, сколько страниц, да ещё и закроет собой чужой комментарий своим «-->».
  const page = rawPage.replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  if (isDefault) templateCache = { doc, page };
  return { doc, page };
}

/** Подстановка `{{КЛЮЧ}}` → значение. Неизвестные ключи остаются как есть — видно прямо в вёрстке. */
function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/**
 * HTML одной страницы документа.
 * @param {object} o
 * @param {object} o.page  страница из parsePdfSpec
 * @param {object} o.theme  тема из render/theme.js
 * @param {string} o.template  содержимое pdf-page.html
 * @param {number} o.total  всего страниц (для колонтитула «3 / 8»)
 */
export function buildPageHtml({ page, theme, template, total }) {
  const title = String(page.title || '').trim();
  const text = String(page.text || '').trim();

  return fill(template, {
    ROLE: page.role || 'body',
    TITLE: escapeHtml(title),
    TEXT: escapeHtml(text),
    TITLE_SIZE: pageTitleSize(title, page.role),
    TEXT_SIZE: pageTextSize(text, page.role),
    NUM: escapeHtml(page.role === 'cover' ? '' : `${page.n} / ${total}`),
    HANDLE: escapeHtml(theme.handle || ''),
    MOTIF: motifSvg(pickMotif(page), theme, page.role),
    LAST: page.n === total ? ' last' : '',
  });
}

/**
 * HTML всего документа: скелет + страницы внутрь.
 * @returns {string} полный HTML-документ, готовый для `page.pdf()`
 */
export function buildPdfHtml({ spec, theme, templates, title = null, size = PAGE_SIZE }) {
  const total = spec.pages.length;
  const pages = spec.pages
    .map((page) => buildPageHtml({ page, theme, template: templates.page, total }))
    .join('\n');

  return fill(templates.doc, {
    W: size.width,
    H: size.height,
    BG: theme.bg,
    FG: theme.fg,
    ACCENT: theme.accent,
    ON_ACCENT: contrastOn(theme.accent),
    FONT: fontStack(theme),
    DOC_TITLE: escapeHtml(title || spec.pages[0]?.title || 'Презентация'),
    PAGES: pages,
  });
}

/**
 * Кегль заголовка страницы. На A4 места больше, чем в кадре 4:5, но и текста на странице больше:
 * обложка кричит, страница раскрытия — уже подзаголовок над абзацем.
 */
export function pageTitleSize(title, role = 'body') {
  const n = String(title || '').length;
  if (role === 'cover') {
    if (n <= 28) return 64;
    if (n <= 60) return 52;
    if (n <= 100) return 42;
    return 34;
  }
  if (n <= 40) return 34;
  if (n <= 80) return 29;
  return 25;
}

/**
 * Кегль текста страницы. Ниже 14px документ перестаёт читаться с телефона, поэтому дальше не
 * уменьшаем: если текста столько, что не влезает, это вопрос к структуре, а не к кеглю.
 */
export function pageTextSize(text, role = 'body') {
  const n = String(text || '').length;
  if (role === 'cover') return n <= 120 ? 24 : 20;
  if (n <= 400) return 20;
  if (n <= 900) return 18;
  if (n <= 1600) return 16;
  return 14;
}

/**
 * Собирает PDF из ответа Презентатора.
 * @param {object} o
 * @param {string} o.content  текст ответа агента (без META-конверта)
 * @param {string} o.outFile  куда положить .pdf (папка создаётся при необходимости)
 * @param {string} [o.brandBrainDir]  откуда брать тему; не задан → нейтральная
 * @param {string} [o.title]  название документа (метаданные PDF и заголовок вкладки)
 * @param {number} [o.maxPages]
 * @returns {Promise<{ok:boolean, file:string, pages:number, truncated:number, spec?:object,
 *   theme?:object, note:string, error?:string}>}
 */
export async function renderPdf({
  content,
  outFile,
  brandBrainDir = null,
  title = null,
  maxPages = MAX_PAGES,
  size = PAGE_SIZE,
}) {
  const spec = parsePdfSpec(content);

  if (!spec.pages.length) {
    return {
      ok: false,
      file: outFile,
      pages: 0,
      truncated: 0,
      note: '',
      error: 'в ответе Презентатора нет ни одного блока «=== СТРАНИЦА N ===» — собирать нечего',
    };
  }

  const truncated = Math.max(0, spec.pages.length - maxPages);
  if (truncated) spec.pages = spec.pages.slice(0, maxPages);

  const theme = brandBrainDir ? await loadTheme(brandBrainDir) : { ...NEUTRAL_THEME };
  const templates = await loadPdfTemplates();
  const html = buildPdfHtml({ spec, theme, templates, title, size });

  await fsp.mkdir(path.dirname(outFile), { recursive: true });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    await page.setContent(html, { waitUntil: 'load' });
    // Как и у слайдов: без этого первая страница иногда печатается системным шрифтом-заглушкой.
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({
      path: outFile,
      // Бумага задаётся ТЕМ ЖЕ числом, что и лист в вёрстке (см. гочу в templates/pdf.html):
      // «A4» словом Chromium считает как 594.96×841.92 pt, лист в 210 мм в неё не влезает,
      // и каждая страница роняет полоску на следующую — в файле выходит вдвое больше листов.
      width: `${size.width}px`,
      height: `${size.height}px`,
      // Без этого Chromium печатает БЕЗ фонов: фирменный фон и акцентная плашка исчезнут.
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } catch (err) {
    return { ok: false, file: outFile, pages: 0, truncated, note: '', error: err.message };
  } finally {
    // Закрываем даже после падения: иначе на VPS остаются висеть процессы Chromium.
    await browser?.close().catch(() => {});
  }

  // Рядом с файлом — разобранная структура. Человеку видно, что именно собралось, а воронке
  // (T14) не нужно открывать PDF, чтобы узнать заголовок и число страниц.
  await fsp
    .writeFile(`${outFile}.json`, JSON.stringify({ ...spec, theme, title, file: outFile }, null, 2), 'utf8')
    .catch(() => {});

  return {
    ok: true,
    file: outFile,
    pages: spec.pages.length,
    truncated,
    spec,
    theme,
    note: pdfNote({ spec, theme, truncated }),
  };
}

/** Подпись к файлу в топике: что собралось и о чём стоит знать владельцу. */
export function pdfNote({ spec, theme, truncated = 0 }) {
  const parts = [describePdfSpec(spec)];
  if (!theme.filled) parts.push('фирменный стиль не задан (brand-brain/08-visual-style.md пуст) — нейтральная тема');
  if (truncated) parts.push(`лишние страницы отброшены: ${truncated} (максимум ${MAX_PAGES})`);
  return parts.join(' · ');
}
