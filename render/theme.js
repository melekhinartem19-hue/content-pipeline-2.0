// Тема рендера: цвета, шрифт и подпись — из «мозга бренда» (T10).
//
// Единственный слот brand-brain, который читает КОД, а не только агент, —
// `brand-brain/08-visual-style.md`. Поэтому строки в нём имеют фиксированный вид:
//
//     - Фон: #0E0E10
//     - Текст: #F5F5F0
//     - Акцент: #C8FF4D
//     - Шрифт: Inter
//     - Подпись: @brand
//
// Правило CLAUDE.md «brand-brain поставляется пустым» здесь соблюдается буквально: пустой слот
// не ломает рендер, а даёт НЕЙТРАЛЬНУЮ тему и флаг `filled:false`. По этому флагу диспетчер
// пишет в топик честную пометку «фирменный стиль не задан» — как и обещает агент-Дизайнер.
//
// Шрифт не скачивается и не встраивается: берём то, что стоит в системе. На VPS (Linux) нужен
// пакет с кириллицей — см. specs/render-visuals.md, раздел «Что нужно на VPS».

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Имя слота с фирменным стилем внутри brand-brain/. */
export const VISUAL_SLOT = '08-visual-style.md';

/**
 * Нейтральная тема — то, чем рендерим, пока клиент не заполнил слот.
 * Тёмный фон + светлый текст: читается в ленте, не притворяется чужим брендом.
 */
export const NEUTRAL_THEME = Object.freeze({
  bg: '#14151a',
  fg: '#f2f2ef',
  accent: '#7c8cf8',
  font: null, // null → системный стек (см. FONT_STACK)
  handle: null,
  filled: false,
});

/** Системный стек с кириллицей: Windows → Linux → общий фолбэк. */
export const FONT_STACK =
  '"Segoe UI", "PT Sans", "DejaVu Sans", "Liberation Sans", "Noto Sans", system-ui, Arial, sans-serif';

const KEYS = [
  { key: 'bg', re: /^\s*[-*]?\s*(?:Фон|Background|BG)\s*:\s*(.+)$/i, type: 'color' },
  { key: 'fg', re: /^\s*[-*]?\s*(?:Текст|Text|Foreground)\s*:\s*(.+)$/i, type: 'color' },
  { key: 'accent', re: /^\s*[-*]?\s*(?:Акцент|Accent)\s*:\s*(.+)$/i, type: 'color' },
  { key: 'font', re: /^\s*[-*]?\s*(?:Шрифт|Font)\s*:\s*(.+)$/i, type: 'text' },
  { key: 'handle', re: /^\s*[-*]?\s*(?:Подпись|Handle|Signature)\s*:\s*(.+)$/i, type: 'text' },
];

/**
 * Разбирает markdown слота в тему. Чистая функция — проверяется оффлайн.
 * Незаполненные и битые значения молча падают в нейтральные: рендер важнее строгости.
 * @param {string} md  содержимое 08-visual-style.md
 * @returns {{bg:string, fg:string, accent:string, font:string|null, handle:string|null, filled:boolean}}
 */
export function parseTheme(md) {
  // Подсказки в <!-- --> — не содержимое: иначе пример «#RRGGBB» из комментария уехал бы в тему.
  const text = String(md || '').replace(/<!--[\s\S]*?-->/g, '');
  const theme = { ...NEUTRAL_THEME };
  let filled = false;

  for (const line of text.split(/\r?\n/)) {
    for (const { key, re, type } of KEYS) {
      const m = re.exec(line);
      if (!m) continue;
      const raw = m[1].trim();
      const value = type === 'color' ? normalizeHex(raw) : raw || null;
      if (value) {
        theme[key] = value;
        filled = true;
      }
    }
  }
  theme.filled = filled;
  return theme;
}

/** Читает тему из каталога brand-brain. Нет каталога/слота → нейтральная тема. */
export async function loadTheme(brandBrainDir) {
  try {
    const md = await fsp.readFile(path.join(brandBrainDir, VISUAL_SLOT), 'utf8');
    return parseTheme(md);
  } catch {
    return { ...NEUTRAL_THEME };
  }
}

/** `#abc` / `abc123` / `#AABBCC` → `#aabbcc`. Не цвет → null. */
export function normalizeHex(input) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(String(input || '').trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

/** CSS-стек шрифтов темы: заданное семейство впереди системного. */
export function fontStack(theme) {
  return theme.font ? `"${theme.font.replace(/"/g, '')}", ${FONT_STACK}` : FONT_STACK;
}

/**
 * Читаемый цвет текста НА акцентной плашке: тёмный на светлом акценте и наоборот.
 * Без этого CTA-слайд, залитый акцентом, теряет текст.
 *
 * Считаем ОБА контраста по WCAG и берём больший, а не сравниваем яркость с порогом «на глаз»:
 * для средних цветов (например, #7c8cf8) глазомерный порог ошибается и выбирает белый там,
 * где чёрный даёт вдвое больший контраст.
 */
export function contrastOn(hexColor) {
  const L = relativeLuminance(hexColor);
  const onWhite = 1.05 / (L + 0.05); // контраст белого текста на этом фоне
  const onBlack = (L + 0.05) / 0.05; // контраст чёрного текста на этом фоне
  return onBlack >= onWhite ? '#111111' : '#ffffff';
}

/** Относительная яркость цвета по WCAG (0 — чёрный, 1 — белый). */
export function relativeLuminance(hexColor) {
  const hex = normalizeHex(hexColor) || '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
