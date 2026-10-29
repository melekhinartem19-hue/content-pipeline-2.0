// Демо рендера без Telegram и без claude -p: пример спецификации → PNG в render/out/ (T10).
//
// Зачем это отдельно от смоука: смоук проверяет утверждениями и подчищает за собой, а сюда
// приходят, когда нужно ПОСМОТРЕТЬ ГЛАЗАМИ — после деплоя на VPS, после правки вёрстки в
// templates/slide.html или после заполнения brand-brain/08-visual-style.md.
//
//   cd render && npm install && npm run demo
//   node render/demo.mjs "путь/к/файлу-со-спецификацией.txt"
//
// Второй вариант удобен, когда Дизайнер уже ответил в топике: скопировал его текст в файл —
// и увидел, что из него получится, не гоняя весь конвейер.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDesign } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Встроенный пример: карусель со всеми тремя ролями слайдов (обложка → раскрытие → CTA). */
const SAMPLE = `Карусель на 5 слайдов, стиль нейтральный.

=== СЛАЙД 1 ===
Заголовок: Почему контент не заходит
Текст: Пять причин, которые видно со стороны
Визуал: крупная цифра в центре, фокус на круге

=== СЛАЙД 2 ===
Заголовок: Причина 1. Нет одной мысли
Текст: Пост пытается сказать всё сразу — и не говорит ничего. Одна публикация = одна мысль.
Визуал: сетка пунктов, чек-лист

=== СЛАЙД 3 ===
Заголовок: Причина 2. Начало без крючка
Текст: Первые две строки решают, дочитают ли остальное. Начинайте с конкретики, а не с разгона.
Визуал: волна, плавный поток внимания

=== СЛАЙД 4 ===
Заголовок: Причина 3. Нет цифр
Текст: «Много клиентов» ничего не значит. «37 заявок за неделю» — значит.
Визуал: столбцы диаграммы, сравнение

=== СЛАЙД 5 ===
Заголовок: Забирайте разбор
Текст: Напишите «разбор» в личные сообщения — пришлём чек-лист по вашим последним постам.
Визуал: мягкое тёплое пятно`;

const fileArg = process.argv[2];
const content = fileArg ? await fsp.readFile(fileArg, 'utf8') : SAMPLE;
const outDir = path.join(__dirname, 'out');
const brandBrainDir = path.join(__dirname, '..', 'brand-brain');

console.log(fileArg ? `Спецификация из файла: ${fileArg}` : 'Спецификация: встроенный пример');
const res = await renderDesign({ content, kind: 'carousel_spec', outDir, brandBrainDir });

if (!res.ok) {
  console.error(`\n⚠️  Рендер не удался: ${res.error}`);
  process.exit(1);
}

console.log(`\n✅ ${res.note}`);
console.log(`Файлы (${res.files.length}) в ${res.dir}:`);
for (const f of res.files) console.log(`  • ${path.basename(f)}`);
console.log('\nОткрой их и посмотри глазами — рендер проверяется только так.');
