// Рендер каруселей и обложек: спецификация Дизайнера → готовые PNG (T10).
//
// Публичный вход модуля `render/`. Всё, что снаружи (диспетчер, скрипты), зовёт только отсюда.
//
// Поток:
//   текст Дизайнера ──parseDesignSpec──▶ слайды ──buildSlideHtml──▶ HTML ──Chromium──▶ PNG
//
// Почему headless Chromium, а не «настоящий» графический движок: слайд — это вёрстка, а Chromium
// её уже умеет. Композиция правится как обычный HTML/CSS (render/templates/slide.html), без
// пересборки кода, и одинаково выглядит на ноуте и на VPS.
//
// Один браузер на всю карусель, одна вкладка, N скриншотов — так рендер 8 слайдов укладывается
// в пару секунд. Браузер закрывается всегда (finally), иначе на VPS накопятся зомби-процессы.
//
// Что этот модуль НЕ делает: не ходит в Telegram, не пишет в БД, не зовёт `claude -p`.
// Он получает текст и отдаёт файлы — поэтому его можно гонять из смоука без ботов и без сети.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseDesignSpec, describeSpec } from './spec.js';
import { loadTheme, NEUTRAL_THEME } from './theme.js';
import { buildSlideHtml, loadTemplate, SLIDE_SIZE } from './html.js';
import { launchBrowser } from './browser.js';

export { parseDesignSpec, describeSpec } from './spec.js';
export { loadTheme, parseTheme, NEUTRAL_THEME } from './theme.js';
export { buildSlideHtml, loadTemplate, SLIDE_SIZE } from './html.js';
export { findBrowser, NO_BROWSER_HINT } from './browser.js';

// PDF-лид-магнит инста-воронки (T13): те же тема и браузер, другой формат листа и другой
// разделитель («=== СТРАНИЦА N ===»). Вход тоже единый — через этот файл.
export {
  renderPdf,
  parsePdfSpec,
  describePdfSpec,
  buildPdfHtml,
  buildPageHtml,
  loadPdfTemplates,
  pdfNote,
  pageTitleSize,
  pageTextSize,
  PAGE_SIZE,
  MAX_PAGES,
} from './pdf.js';

/**
 * Больше 10 слайдов не рендерим. Совпадение приятное и неслучайное: столько же максимум
 * в карусели Instagram и в одном media-group Telegram — значит лишние кадры всё равно
 * некуда деть. Хвост честно отбрасываем и сообщаем об этом.
 */
export const MAX_SLIDES = 10;

/**
 * Рендерит спецификацию Дизайнера в набор PNG.
 * @param {object} o
 * @param {string} o.content  текст ответа Дизайнера (без META-конверта)
 * @param {string} [o.kind]  carousel_spec | cover_spec — подсказка формата из META
 * @param {string} o.outDir  куда складывать файлы (создаётся при необходимости)
 * @param {string} [o.brandBrainDir]  откуда брать тему; не задан → нейтральная
 * @param {{width:number,height:number}} [o.size]
 * @param {number} [o.maxSlides]
 * @returns {Promise<{ok:boolean, dir:string, files:string[], spec?:object, theme?:object,
 *   truncated:number, note:string, error?:string}>}
 */
export async function renderDesign({
  content,
  kind = null,
  outDir,
  brandBrainDir = null,
  size = SLIDE_SIZE,
  maxSlides = MAX_SLIDES,
}) {
  const spec = parseDesignSpec(content, { kind });

  if (!spec.slides.length) {
    return {
      ok: false,
      dir: outDir,
      files: [],
      truncated: 0,
      note: '',
      error: 'в ответе Дизайнера нет ни одного блока «=== СЛАЙД N ===» / «=== ОБЛОЖКА ===» — рендерить нечего',
    };
  }

  const truncated = Math.max(0, spec.slides.length - maxSlides);
  if (truncated) spec.slides = spec.slides.slice(0, maxSlides);

  const theme = brandBrainDir ? await loadTheme(brandBrainDir) : { ...NEUTRAL_THEME };
  const template = await loadTemplate();

  await fsp.mkdir(outDir, { recursive: true });

  let browser;
  const files = [];
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });

    for (const slide of spec.slides) {
      const html = buildSlideHtml({ slide, theme, template, total: spec.slides.length, size });
      await page.setContent(html, { waitUntil: 'load' });
      // Без этого первый кадр иногда снимается системным шрифтом-заглушкой: браузер уже
      // отрисовал страницу, но фирменное семейство ещё подгружается.
      await page.evaluate(() => document.fonts.ready);

      const file = path.join(outDir, slideFileName(slide, spec, spec.slides.length));
      await page.screenshot({ path: file, type: 'png' });
      files.push(file);
    }
  } catch (err) {
    return { ok: false, dir: outDir, files, truncated, note: '', error: err.message };
  } finally {
    // Закрываем даже после падения: иначе на VPS остаются висеть процессы Chromium.
    await browser?.close().catch(() => {});
  }

  // Рядом с картинками — разобранная спецификация. Пригодится и человеку (что именно
  // отрендерилось), и коду: IG-публикация (T12) и сборка PDF (T13) возьмут подписи отсюда.
  await fsp
    .writeFile(path.join(outDir, 'slides.json'), JSON.stringify({ ...spec, theme, files }, null, 2), 'utf8')
    .catch(() => {});

  return { ok: true, dir: outDir, files, spec, theme, truncated, note: renderNote({ spec, theme, truncated }) };
}

/** Имя файла кадра: обложка — cover.png, слайды карусели — slide-01.png … */
function slideFileName(slide, spec, total) {
  if (spec.format === 'cover' || total === 1) return 'cover.png';
  return `slide-${String(slide.n).padStart(2, '0')}.png`;
}

/**
 * Подпись под картинками в топике: что отрендерили и о чём стоит знать владельцу.
 * Пустой brand-brain — не ошибка, но человек должен видеть, почему визуал обезличенный.
 */
export function renderNote({ spec, theme, truncated = 0 }) {
  const parts = [describeSpec(spec)];
  if (!theme.filled) parts.push('фирменный стиль не задан (brand-brain/08-visual-style.md пуст) — нейтральная тема');
  if (truncated) parts.push(`лишние кадры отброшены: ${truncated} (максимум ${MAX_SLIDES})`);
  return parts.join(' · ');
}
