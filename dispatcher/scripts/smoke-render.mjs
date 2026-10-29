// Смоук-тест рендера каруселей и обложек (T10): разбор спецификации, тема, вёрстка, PNG.
// Оффлайн: ни Telegram, ни claude -p, ни сети. Запуск: node dispatcher/scripts/smoke-render.mjs
//
// Последний блок (настоящий рендер в PNG) требует установленного Chromium. Если браузера нет —
// блок пропускается с явным предупреждением, а не роняет смоук: на машине без браузера должно
// быть видно, что парсер и вёрстка проверены, а рендер — нет.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_SLIDES,
  buildSlideHtml,
  describeSpec,
  findBrowser,
  loadTemplate,
  parseDesignSpec,
  parseTheme,
  renderDesign,
} from '../../render/index.js';
import { contrastOn, fontStack, normalizeHex } from '../../render/theme.js';
import { escapeHtml, pickMotif, textSize, titleSize } from '../../render/html.js';
import { BRAND_BRAIN_DIR } from '../src/config.js';

// ── Разбор спецификации Дизайнера ─────────────────────────────────────────
const CAROUSEL = `Карусель на 4 слайда, стиль нейтральный.

=== СЛАЙД 1 ===
Заголовок: Три ошибки новичка
Текст: Разбираем на пальцах
Визуал: крупная цифра, акцент в центре круга

=== СЛАЙД 2 ===
Заголовок: Ошибка первая
Текст: Начинают с инструментов,
а не с задачи
Визуал: чек-лист, сетка пунктов

=== СЛАЙД 3 ===
Заголовок: Ошибка вторая
Текст: Меряют процесс, а не результат
Визуал: столбцы диаграммы

=== СЛАЙД 4 ===
Заголовок: С чего начать
Текст: Забирайте разбор в шапке профиля
Визуал: мягкое пятно, тёплое настроение`;

const spec = parseDesignSpec(CAROUSEL, { kind: 'carousel_spec' });
assert.equal(spec.format, 'carousel', 'формат — карусель');
assert.equal(spec.slides.length, 4, 'разобрано 4 слайда');
assert.equal(spec.summary, 'Карусель на 4 слайда, стиль нейтральный.', 'резюме агента отделено от слайдов');
assert.equal(spec.slides[0].title, 'Три ошибки новичка', 'заголовок первого слайда');
assert.equal(spec.slides[1].text, 'Начинают с инструментов,\nа не с задачи', 'многострочное поле склеено целиком');
assert.deepEqual(
  spec.slides.map((s) => s.role),
  ['cover', 'body', 'body', 'cta'],
  'роли: первый — обложка, последний — призыв',
);
assert.match(describeSpec(spec), /карусель, слайдов: 4/, 'сводка разбора читаемая');

// Обложка — один кадр, роль всегда cover.
const cover = parseDesignSpec('Обложка.\n\n=== ОБЛОЖКА ===\nЗаголовок: Тариф\nТекст: Коротко о главном', {
  kind: 'cover_spec',
});
assert.equal(cover.format, 'cover', 'одиночный разделитель → обложка');
assert.equal(cover.slides.length, 1, 'у обложки один кадр');
assert.equal(cover.slides[0].role, 'cover', 'роль обложки');

// META говорит «обложка», а разделители — «слайды»: верим разделителям, кадров-то много.
const mixed = parseDesignSpec('=== СЛАЙД 1 ===\nЗаголовок: А\n\n=== СЛАЙД 2 ===\nЗаголовок: Б', {
  kind: 'cover_spec',
});
assert.equal(mixed.format, 'carousel', 'разделители сильнее подсказки из META');

// Агент съехал с формата — рендерить нечего, но парсер не падает.
assert.equal(parseDesignSpec('Просто текст без разделителей').slides.length, 0, 'нет разделителей → нет слайдов');

// Блок без полей не теряется: его текст становится телом слайда.
const loose = parseDesignSpec('=== СЛАЙД 1 ===\nпросто строка без полей');
assert.equal(loose.slides[0].text, 'просто строка без полей', 'блок без полей не пустой');

// ── Тема из brand-brain ───────────────────────────────────────────────────
const emptySlot = await fsp.readFile(path.join(BRAND_BRAIN_DIR, '08-visual-style.md'), 'utf8');
const neutral = parseTheme(emptySlot);
assert.equal(neutral.filled, false, 'пустой слот 08-visual-style.md → тема не заполнена');
assert.equal(normalizeHex(neutral.bg), neutral.bg, 'нейтральные цвета — валидные hex');

const filled = parseTheme(`
## Цвета
- Фон: #0E0E10
- Текст: #F5F5F0
- Акцент: #c8ff4d

## Шрифт
- Шрифт: Inter

## Подпись на слайде
- Подпись: @brand
`);
assert.equal(filled.filled, true, 'заполненный слот распознан');
assert.deepEqual(
  [filled.bg, filled.fg, filled.accent, filled.font, filled.handle],
  ['#0e0e10', '#f5f5f0', '#c8ff4d', 'Inter', '@brand'],
  'цвета, шрифт и подпись прочитаны',
);
assert.match(fontStack(filled), /^"Inter",/, 'заданный шрифт впереди системного стека');

// Подсказки в <!-- --> не должны попадать в тему.
assert.equal(parseTheme('<!-- - Фон: #ff0000 -->').filled, false, 'комментарии-подсказки не считаются значением');
assert.equal(normalizeHex('не цвет'), null, 'мусор вместо цвета отбрасывается');
assert.equal(normalizeHex('#abc'), '#aabbcc', 'короткий hex разворачивается');
assert.equal(contrastOn('#ffffff'), '#111111', 'на светлом акценте — тёмный текст');
assert.equal(contrastOn('#0e0e10'), '#ffffff', 'на тёмном акценте — светлый текст');
// Средние цвета — тот случай, где глазомерный порог ошибается: на #7c8cf8 чёрный даёт
// контраст ~7:1, белый — всего ~3:1, поэтому текст обязан быть тёмным.
assert.equal(contrastOn('#7c8cf8'), '#111111', 'на среднем акценте выбирается больший контраст');

// ── Вёрстка слайда ────────────────────────────────────────────────────────
const template = await loadTemplate();
const html = buildSlideHtml({ slide: spec.slides[0], theme: filled, template, total: 4 });
assert.ok(!html.includes('{{'), 'все плейсхолдеры шаблона подставлены');
assert.match(html, /data-role="cover"/, 'роль слайда попала в разметку');
assert.match(html, /#c8ff4d/, 'акцент темы применён');
assert.match(html, /Три ошибки новичка/, 'заголовок в разметке');
assert.match(html, />1\/4</, 'бейдж «номер/всего»');
assert.match(html, /@brand/, 'подпись бренда в подвале');
assert.match(html, /width: 1080px/, 'кадр 1080×1350');

// Текст от языковой модели в разметку попадает только экранированным.
const evil = buildSlideHtml({
  slide: { n: 1, role: 'body', title: '<script>alert(1)</script>', text: 'a & b', visual: null },
  theme: filled,
  template,
  total: 1,
});
assert.ok(!evil.includes('<script>alert'), 'разметка из текста агента экранирована');
assert.match(evil, /&lt;script&gt;/, 'угловые скобки заменены сущностями');
assert.match(evil, /a &amp; b/, 'амперсанд экранирован');
assert.equal(escapeHtml('"x"'), '&quot;x&quot;', 'кавычки экранируются');

// Кегль подстраивается под длину: длинный заголовок мельче короткого.
assert.ok(titleSize('Коротко') > titleSize('А'.repeat(140)), 'длинный заголовок ужимается');
assert.ok(textSize('А'.repeat(50)) > textSize('А'.repeat(600)), 'длинный текст ужимается');

// Мотив-подложка выбирается по описанию визуала, иначе по номеру слайда.
assert.equal(pickMotif({ n: 1, visual: 'чек-лист по пунктам' }), 'grid', 'ключевое слово → мотив grid');
assert.equal(pickMotif({ n: 1, visual: 'столбцы диаграммы' }), 'bars', 'ключевое слово → мотив bars');
assert.equal(pickMotif({ n: 1, visual: 'крупная цифра, фокус на круге' }), 'arc', 'слово «цифра» не перебивает круг');
assert.equal(pickMotif({ n: 3, visual: null }), pickMotif({ n: 3, visual: '' }), 'без описания мотив по номеру');
assert.notEqual(pickMotif({ n: 1, visual: null }), pickMotif({ n: 2, visual: null }), 'соседние слайды не одинаковы');

// ── Настоящий рендер в PNG (нужен Chromium) ───────────────────────────────
const browser = findBrowser();
if (!browser) {
  console.warn('⚠️  Chromium не найден — блок рендера в PNG пропущен (см. render/browser.js, NO_BROWSER_HINT).');
} else {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-render-'));
  const res = await renderDesign({ content: CAROUSEL, kind: 'carousel_spec', outDir, brandBrainDir: BRAND_BRAIN_DIR });

  assert.ok(res.ok, `рендер прошёл: ${res.error || ''}`);
  assert.equal(res.files.length, 4, 'получилось 4 файла');
  for (const file of res.files) {
    const buf = await fsp.readFile(file);
    assert.ok(buf.length > 5000, `${path.basename(file)} не пустой (${buf.length} байт)`);
    assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${path.basename(file)} — настоящий PNG`);
  }
  assert.ok(fs.existsSync(path.join(outDir, 'slides.json')), 'рядом с картинками лежит разбор slides.json');
  assert.match(res.note, /фирменный стиль не задан/, 'пустой brand-brain честно помечен в подписи');

  // Обложка кладётся под своим именем — по нему её видно среди файлов.
  const coverDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-render-'));
  const coverRes = await renderDesign({
    content: '=== ОБЛОЖКА ===\nЗаголовок: Обложка\nТекст: Один кадр',
    kind: 'cover_spec',
    outDir: coverDir,
  });
  assert.ok(coverRes.ok, `рендер обложки прошёл: ${coverRes.error || ''}`);
  assert.equal(path.basename(coverRes.files[0]), 'cover.png', 'обложка называется cover.png');

  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.rm(coverDir, { recursive: true, force: true });
  console.log(`   (рендер выполнен браузером: ${browser})`);
}

// Спецификация длиннее лимита обрезается, а не рендерится бесконечно.
const long = Array.from({ length: MAX_SLIDES + 3 }, (_, i) => `=== СЛАЙД ${i + 1} ===\nЗаголовок: ${i + 1}`).join('\n\n');
assert.equal(parseDesignSpec(long).slides.length, MAX_SLIDES + 3, 'парсер отдаёт всё, что нашёл');

// Нечего рендерить — честная ошибка, а не пустая папка с картинками.
const nothing = await renderDesign({ content: 'текст без разделителей', outDir: path.join(os.tmpdir(), 'cp-none') });
assert.equal(nothing.ok, false, 'без блоков рендер не запускается');
assert.match(nothing.error, /нет ни одного блока/, 'причина понятна человеку');

console.log('✅ smoke-render: спецификация, тема, вёрстка и PNG — ок');
