// Сборка HTML одного слайда из шаблона + данных (T10).
//
// Разделение внутри render/: `templates/slide.html` — вёрстка и CSS (правит человек),
// этот файл — подстановка значений и решения, которые вёрстке не по силам:
//   • размер шрифта по длине текста (в кадре 1080×1350 нет скролла — не влезло значит потеряно);
//   • абстрактный мотив-подложка по полю «Визуал» (нарисовать описанную идею мы не можем,
//     но можем не оставлять кадр пустым — см. ниже честную оговорку);
//   • экранирование: текст приходит от языковой модели, в HTML он попадает только через escapeHtml.
//
// ЧЕСТНАЯ ОГОВОРКА ПРО «ВИЗУАЛ». Поле `Визуал:` у Дизайнера — это идея кадра словами
// («крупный план чашки, акцент на пар»). Иллюстрацию по ней здесь никто не рисует: рендер
// типографский. Из описания достаётся только МОТИВ — геометрическая подложка (сетка, волна,
// дуга, столбцы, пятно), чтобы слайды одной карусели не выглядели одинаковыми. Генерация
// настоящих иллюстраций — это отдельная история (Higgsfield/Figma), в T10 её нет.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontStack, contrastOn } from './theme.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(__dirname, 'templates', 'slide.html');

/** Размер кадра по умолчанию: вертикаль 4:5 — максимум площади в ленте Instagram. */
export const SLIDE_SIZE = Object.freeze({ width: 1080, height: 1350 });

let templateCache = null;

/** Читает шаблон с диска (один раз за процесс). */
export async function loadTemplate(templatePath = TEMPLATE_PATH) {
  if (templatePath === TEMPLATE_PATH && templateCache) return templateCache;
  const html = await fsp.readFile(templatePath, 'utf8');
  if (templatePath === TEMPLATE_PATH) templateCache = html;
  return html;
}

/**
 * Подставляет значения в шаблон.
 * @param {object} o
 * @param {object} o.slide  слайд из parseDesignSpec: { n, role, title, text, visual }
 * @param {object} o.theme  тема из render/theme.js
 * @param {string} o.template  содержимое slide.html
 * @param {number} o.total  всего слайдов (для бейджа «2/7»)
 * @param {{width:number, height:number}} [o.size]
 * @returns {string} полный HTML-документ слайда
 */
export function buildSlideHtml({ slide, theme, template, total, size = SLIDE_SIZE }) {
  const title = String(slide.title || '').trim();
  const text = String(slide.text || '').trim();

  const values = {
    W: size.width,
    H: size.height,
    ROLE: slide.role || 'body',
    BG: theme.bg,
    FG: theme.fg,
    ACCENT: theme.accent,
    ON_ACCENT: contrastOn(theme.accent),
    FONT: fontStack(theme),
    TITLE: escapeHtml(title),
    TEXT: escapeHtml(text),
    TITLE_SIZE: titleSize(title),
    TEXT_SIZE: textSize(text),
    BADGE: escapeHtml(total > 1 ? `${slide.n}/${total}` : '01'),
    HANDLE: escapeHtml(theme.handle || ''),
    MOTIF: motifSvg(pickMotif(slide), theme, slide.role),
  };

  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/** Экранирование под HTML. Единственная дверь для текста агента в разметку. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Кегль заголовка по длине: кадр фиксированный, поэтому длинный хук должен ужаться сам. */
export function titleSize(title) {
  const n = title.length;
  if (n <= 24) return 108;
  if (n <= 45) return 92;
  if (n <= 80) return 76;
  if (n <= 130) return 62;
  return 52;
}

/** Кегль основного текста. Ниже 25px подпись в ленте уже не читается — дальше не уменьшаем. */
export function textSize(text) {
  const n = text.length;
  if (n <= 90) return 46;
  if (n <= 180) return 40;
  if (n <= 320) return 34;
  if (n <= 520) return 29;
  return 25;
}

// ── Мотивы-подложки ────────────────────────────────────────────────────────
// Ключевые слова ищем в поле «Визуал», а если оно пустое — берём мотив по номеру слайда,
// чтобы карусель всё равно не выглядела как один и тот же кадр N раз.

const MOTIF_RULES = [
  { motif: 'bars', re: /столб|диаграмм|сравнен|процент|график|метрик/i },
  { motif: 'grid', re: /сетк|таблиц|структур|чек-?лист|список|шаг|пункт|схем/i },
  { motif: 'wave', re: /волн|поток|плавн|рост|динам|кривая|путь/i },
  { motif: 'arc', re: /круг|цикл|кольц|солнц|фокус|центр|орбит/i },
  { motif: 'blob', re: /мягк|тепл|эмоц|истор|люд|уют|настроен/i },
];

const MOTIF_ORDER = ['blob', 'grid', 'wave', 'arc', 'bars'];

/** Мотив для слайда: по описанию визуала, иначе по порядковому номеру. */
export function pickMotif(slide) {
  const visual = String(slide?.visual || '');
  const hit = MOTIF_RULES.find((r) => r.re.test(visual));
  if (hit) return hit.motif;
  return MOTIF_ORDER[((slide?.n || 1) - 1) % MOTIF_ORDER.length];
}

/**
 * SVG-подложка. Рисуется акцентным цветом с низкой непрозрачностью — это фон, а не картинка:
 * текст поверх обязан оставаться читаемым (иначе теряется весь смысл слайда).
 */
export function motifSvg(motif, theme, role = 'body') {
  const color = role === 'cta' ? contrastOn(theme.accent) : theme.accent;
  const o = role === 'cta' ? 0.18 : 0.16;
  const box = 'viewBox="0 0 1080 1350" preserveAspectRatio="xMidYMid slice"';

  const shapes = {
    grid: `<g fill="${color}" opacity="${o}">${dots()}</g>`,
    wave: `<g fill="none" stroke="${color}" stroke-width="10" opacity="${o}">
        <path d="M-40 980 C 220 860, 380 1120, 640 1000 S 1000 860, 1140 940" />
        <path d="M-40 1080 C 220 960, 380 1220, 640 1100 S 1000 960, 1140 1040" />
        <path d="M-40 1180 C 220 1060, 380 1320, 640 1200 S 1000 1060, 1140 1140" />
      </g>`,
    arc: `<g fill="none" stroke="${color}" stroke-width="12" opacity="${o}">
        <circle cx="900" cy="1180" r="240" />
        <circle cx="900" cy="1180" r="360" />
        <circle cx="900" cy="1180" r="480" />
      </g>`,
    bars: `<g fill="${color}" opacity="${o}">
        <rect x="700" y="900" width="70" height="380" rx="12" />
        <rect x="800" y="780" width="70" height="500" rx="12" />
        <rect x="900" y="1020" width="70" height="260" rx="12" />
        <rect x="1000" y="640" width="70" height="640" rx="12" />
      </g>`,
    blob: `<g opacity="${o}"><circle cx="880" cy="240" r="330" fill="${color}" />
        <circle cx="140" cy="1180" r="220" fill="${color}" /></g>`,
  };

  return `<svg ${box} xmlns="http://www.w3.org/2000/svg">${shapes[motif] || shapes.blob}</svg>`;
}

/** Точечная сетка для мотива grid. */
function dots() {
  const out = [];
  for (let y = 120; y <= 1260; y += 90) {
    for (let x = 60; x <= 1020; x += 90) out.push(`<circle cx="${x}" cy="${y}" r="6"/>`);
  }
  return out.join('');
}
