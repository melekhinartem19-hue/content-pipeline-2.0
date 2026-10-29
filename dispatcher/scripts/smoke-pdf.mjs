// Смоук-тест сборки PDF-лид-магнита (T13): разбор структуры, вёрстка листа, настоящий PDF.
// Оффлайн: ни Telegram, ни claude -p, ни сети. Запуск: node dispatcher/scripts/smoke-pdf.mjs
//
// Последний блок (настоящая печать в PDF) требует установленного Chromium. Если браузера нет —
// блок пропускается с явным предупреждением, а не роняет смоук: на машине без браузера должно
// быть видно, что парсер и вёрстка проверены, а печать — нет.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PAGES,
  buildPdfHtml,
  describePdfSpec,
  findBrowser,
  loadPdfTemplates,
  pageTextSize,
  pageTitleSize,
  parsePdfSpec,
  parseTheme,
  renderPdf,
} from '../../render/index.js';
import { BRAND_BRAIN_DIR } from '../src/config.js';

// ── Разбор структуры Презентатора ─────────────────────────────────────────
const SPEC = `Лид-магнит по теме «контент-план», 4 страницы.

=== СТРАНИЦА 1 ===
Заголовок: Контент-план за час
Текст: Для тех, кто каждый день думает, что постить
Визуал: крупная типографика, акцент снизу

=== СТРАНИЦА 2 ===
Заголовок: Шаг 1. Соберите темы
Текст: Заведите список
и складывайте туда всё
Визуал: чек-лист, сетка пунктов

=== СТРАНИЦА 3 ===
Заголовок: Шаг 2. Три полки
Текст: Польза, доверие, продажа — в пропорции 3:2:1.
Визуал: столбцы сравнения

=== СТРАНИЦА 4 ===
Заголовок: Заберите шаблон
Текст: Напишите «план» в директ.
Визуал: мягкое тёплое пятно`;

const spec = parsePdfSpec(SPEC);
assert.equal(spec.format, 'pdf', 'формат — документ');
assert.equal(spec.pages.length, 4, 'разобрано 4 страницы');
assert.equal(spec.summary, 'Лид-магнит по теме «контент-план», 4 страницы.', 'резюме агента отделено от страниц');
assert.equal(spec.pages[0].title, 'Контент-план за час', 'заголовок обложки');
assert.equal(spec.pages[1].text, 'Заведите список\nи складывайте туда всё', 'многострочное поле склеено целиком');
assert.deepEqual(
  spec.pages.map((p) => p.role),
  ['cover', 'body', 'body', 'cta'],
  'роли: первая — обложка, последняя — призыв',
);
assert.match(describePdfSpec(spec), /страниц: 4/, 'сводка разбора читаемая');

// Две страницы — это ещё не «обложка + финал»: призыв появляется только с третьей.
assert.deepEqual(
  parsePdfSpec('=== СТРАНИЦА 1 ===\nЗаголовок: А\n\n=== СТРАНИЦА 2 ===\nЗаголовок: Б').pages.map((p) => p.role),
  ['cover', 'body'],
  'из двух страниц финальной не делаем',
);

// Разделители слайдов (T10) страницами НЕ считаются: у Дизайнера и Презентатора разные ветки.
assert.equal(parsePdfSpec('=== СЛАЙД 1 ===\nЗаголовок: А').pages.length, 0, 'слайд — не страница PDF');
assert.equal(parsePdfSpec('Просто текст без разделителей').pages.length, 0, 'нет разделителей → нет страниц');

// Блок без полей не теряется: его текст становится телом страницы.
assert.equal(parsePdfSpec('=== СТРАНИЦА 1 ===\nпросто строка').pages[0].text, 'просто строка', 'блок без полей не пуст');

// Латинские варианты разделителя и полей — на случай, если агент ответил по-английски.
assert.equal(parsePdfSpec('=== PAGE 1 ===\nTitle: Hi\nText: There').pages[0].title, 'Hi', 'PAGE/Title тоже понимаются');

// ── Вёрстка листа ─────────────────────────────────────────────────────────
const theme = parseTheme(`
- Фон: #0E0E10
- Текст: #F5F5F0
- Акцент: #c8ff4d
- Шрифт: Inter
- Подпись: @brand
`);
const templates = await loadPdfTemplates();
const html = buildPdfHtml({ spec, theme, templates, title: 'Контент-план' });

assert.ok(!html.includes('{{'), 'все плейсхолдеры шаблонов подставлены');
assert.equal((html.match(/<section/g) || []).length, 4, 'в документе ровно 4 листа');
assert.match(html, /data-role="cover"/, 'роль страницы попала в разметку');
assert.match(html, /data-role="cta"/, 'финальная страница получила свою роль');
assert.match(html, /#c8ff4d/, 'акцент темы применён');
assert.match(html, /@brand/, 'подпись бренда в подвале');
assert.match(html, /size: 794px 1123px/, 'бумага — A4 в пикселях');
assert.match(html, />2 \/ 4</, 'колонтитул «страница из скольких»');
assert.ok(!/>1 \/ 4</.test(html), 'на обложке номера нет');

// Текст от языковой модели попадает в разметку только экранированным.
const evil = buildPdfHtml({
  spec: parsePdfSpec('=== СТРАНИЦА 1 ===\nЗаголовок: <script>alert(1)</script>\nТекст: a & b'),
  theme,
  templates,
});
assert.ok(!evil.includes('<script>alert'), 'разметка из текста агента экранирована');
assert.match(evil, /&lt;script&gt;/, 'угловые скобки заменены сущностями');
assert.match(evil, /a &amp; b/, 'амперсанд экранирован');

// Кегль подстраивается под длину и под роль страницы.
assert.ok(pageTitleSize('Коротко', 'cover') > pageTitleSize('Коротко', 'body'), 'обложка кричит громче страницы');
assert.ok(pageTitleSize('А', 'cover') > pageTitleSize('А'.repeat(120), 'cover'), 'длинный заголовок ужимается');
assert.ok(pageTextSize('А'.repeat(300)) > pageTextSize('А'.repeat(2000)), 'длинный текст ужимается');
assert.equal(pageTextSize('А'.repeat(5000)), 14, 'ниже 14px не опускаемся — читаемость важнее');

// ── Настоящая печать в PDF (нужен Chromium) ───────────────────────────────
const browser = findBrowser();
if (!browser) {
  console.warn('⚠️  Chromium не найден — блок печати в PDF пропущен (см. render/browser.js, NO_BROWSER_HINT).');
} else {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-pdf-'));
  const outFile = path.join(dir, 'lead-magnet.pdf');
  const res = await renderPdf({ content: SPEC, outFile, brandBrainDir: BRAND_BRAIN_DIR, title: 'Контент-план' });

  assert.ok(res.ok, `сборка прошла: ${res.error || ''}`);
  assert.equal(res.pages, 4, 'в результате 4 страницы');

  const buf = await fsp.readFile(outFile);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-', 'файл — настоящий PDF');
  assert.ok(buf.length > 10_000, `файл не пустой (${buf.length} байт)`);

  // ГЛАВНАЯ ПРОВЕРКА ЭТОГО СМОУКА: листов в файле ровно столько, сколько страниц в структуре.
  // Именно здесь ловятся «лишние пустые листы» — их даёт любое расхождение размера бумаги и
  // размера вёрстки (см. комментарий в render/templates/pdf.html).
  const sheets = [...buf.toString('latin1').matchAll(/\/Type\s*\/Page(?![s])/g)].length;
  assert.equal(sheets, 4, `в PDF ровно 4 листа, без пустых (нашлось ${sheets})`);

  assert.ok(await fsp.stat(`${outFile}.json`).then(() => true, () => false), 'рядом с PDF лежит разбор структуры');
  assert.match(res.note, /фирменный стиль не задан/, 'пустой brand-brain честно помечен в подписи');

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`   (PDF напечатан браузером: ${browser})`);
}

// Структура длиннее лимита обрезается, а не печатается бесконечно.
const long = Array.from({ length: MAX_PAGES + 3 }, (_, i) => `=== СТРАНИЦА ${i + 1} ===\nЗаголовок: ${i + 1}`).join('\n\n');
assert.equal(parsePdfSpec(long).pages.length, MAX_PAGES + 3, 'парсер отдаёт всё, что нашёл — режет уже рендер');

// Собирать нечего — честная ошибка, а не пустой PDF.
const nothing = await renderPdf({ content: 'текст без разделителей', outFile: path.join(os.tmpdir(), 'cp-none.pdf') });
assert.equal(nothing.ok, false, 'без блоков сборка не запускается');
assert.match(nothing.error, /нет ни одного блока/, 'причина понятна человеку');

console.log('✅ smoke-pdf: структура, вёрстка листа и печать в PDF — ок');
