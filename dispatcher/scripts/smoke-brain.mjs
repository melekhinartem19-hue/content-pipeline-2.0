// Смоук «Мозга бренда» (T18) БЕЗ Telegram и сети: идеи → 09-inbox.md, файлы → materials/,
// и главное — что агенты это действительно увидят (loadBrandBrain).
// Запуск: node dispatcher/scripts/smoke-brain.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadBrandBrain } from '../src/agent.js';
import { enabledIdentities } from '../src/bots/registry.js';
import { shouldHandle } from '../src/bots/router.js';
import {
  INBOX_FILE,
  INBOX_TEMPLATE,
  INBOX_WARN_CHARS,
  MATERIALS_SUBDIR,
  TG_DOWNLOAD_LIMIT,
  createAlbumCollector,
  createBrainInbox,
  describeMedia,
  formatEntry,
  forwardLabel,
  inboxSizeWarning,
  materialFileName,
  parseBrainCommand,
  parseEntries,
  renderIdeaReply,
  renderInboxSummary,
  renderMaterialReply,
} from '../src/brain/inbox.js';

const now = new Date(2026, 8, 10, 14, 32, 5);

// ── Шаблон в репозитории = шаблон в коде ────────────────────────────────────────────────
// Бот сам создаёт слот из INBOX_TEMPLATE, если файла нет. Разъедутся — на сервере и в репо будут
// два разных «пустых» слота. Сверяем только НЕТРОНУТЫЙ слот: смоук гоняют и на VPS, а там в
// «Входящих» уже записи клиента (или файла ещё нет — бот создаст его сам). Это данные, не код.
const repoInbox = new URL(`../../brand-brain/${INBOX_FILE}`, import.meta.url);
if (fs.existsSync(repoInbox)) {
  const repoTemplate = fs.readFileSync(repoInbox, 'utf8').replace(/\r\n/g, '\n');
  if (!parseEntries(repoTemplate).length) {
    assert.equal(repoTemplate, INBOX_TEMPLATE, 'нетронутый brand-brain/09-inbox.md совпадает с INBOX_TEMPLATE');
  }
}

// ── Имена файлов ────────────────────────────────────────────────────────────────────────
assert.equal(
  materialFileName({ original: 'Прайс 2026.PDF', kind: 'файл', messageId: 77, now }),
  '20260910-143205-77-Прайс-2026.pdf',
  'кириллица остаётся, пробелы → дефис, расширение в нижнем регистре',
);
assert.equal(
  materialFileName({ original: '', kind: 'фото', messageId: 5, defaultExt: '.jpg', now }),
  '20260910-143205-5-photo.jpg',
  'у фото имени нет — берётся вид и расширение по умолчанию',
);
assert.equal(
  materialFileName({ original: 'отчёт.пдф', kind: 'файл', messageId: 3, now }),
  '20260910-143205-3-отчёт.пдф',
  'кириллическое расширение не превращается в голую точку на конце имени',
);
const evil = materialFileName({ original: '../../dispatcher/.env', kind: 'файл', messageId: 1, now });
assert.ok(!evil.includes('/') && !evil.includes('\\') && !evil.startsWith('.'), `путь из имени выброшен: ${evil}`);
assert.ok(!materialFileName({ original: 'C:\\Users\\x\\a.txt', messageId: 1, now }).includes('\\'), 'windows-путь тоже');
assert.notEqual(
  materialFileName({ original: 'a.jpg', messageId: 1, now }),
  materialFileName({ original: 'a.jpg', messageId: 2, now }),
  'альбом в одну секунду не затирает сам себя',
);

// ── Что прислали ────────────────────────────────────────────────────────────────────────
const photo = describeMedia({
  photo: [
    { file_id: 'small', file_size: 1_000 },
    { file_id: 'big', file_size: 90_000 },
  ],
});
assert.deepEqual([photo.kind, photo.fileId, photo.size], ['фото', 'big', 90_000], 'фото: берётся самый крупный размер');
assert.equal(describeMedia({ video: { file_id: 'v', mime_type: 'video/quicktime' } }).defaultExt, '.mov', 'видео: расширение по MIME');
assert.equal(describeMedia({ video_note: { file_id: 'n' } }).kind, 'видео', 'кружок — это видео');
assert.equal(describeMedia({ document: { file_id: 'd', file_name: 'бриф.docx' } }).original, 'бриф.docx', 'документ: исходное имя');
assert.equal(describeMedia({ animation: { file_id: 'g' }, document: { file_id: 'g' } }).kind, 'файл', 'GIF сохраняется как файл');
assert.equal(describeMedia({ voice: { file_id: 'x' } }), null, 'голосовое не храним — агент его не услышит');
assert.equal(describeMedia({ text: 'привет' }), null, 'текст — не файл');

// ── Откуда переслано ────────────────────────────────────────────────────────────────────
assert.equal(
  forwardLabel({ type: 'channel', chat: { username: 'brand' }, message_id: 42 }),
  '@brand, https://t.me/brand/42',
  'пост публичного канала — со ссылкой на первоисточник',
);
assert.equal(forwardLabel({ type: 'channel', chat: { title: 'Закрытый' } }), 'Закрытый', 'закрытый канал — по названию');
assert.equal(forwardLabel({ type: 'hidden_user', sender_user_name: 'Аня' }), 'Аня', 'скрытый отправитель — по имени');
assert.equal(forwardLabel(undefined), null, 'не пересланное');

// ── Формат записи ───────────────────────────────────────────────────────────────────────
const multi = formatEntry({ text: 'Первая мысль\n# не заголовок\n\nхвост', now });
assert.ok(multi.startsWith('- **2026-09-10 14:32 · идея** — Первая мысль\n'), 'запись — пункт списка с меткой');
assert.ok(multi.includes('\n  # не заголовок\n'), 'строка с «#» сдвинута и не станет заголовком');
assert.equal(parseEntries(multi + formatEntry({ text: 'вторая', now })).length, 2, 'многострочная запись считается одной');

// ── Команды ─────────────────────────────────────────────────────────────────────────────
assert.deepEqual(parseBrainCommand('/входящие'), { action: 'list' }, '/входящие');
assert.deepEqual(parseBrainCommand('/входящие@brand_brain_bot'), { action: 'list' }, 'форма с @ботом в группе');
assert.deepEqual(parseBrainCommand('/start'), { action: 'help' }, '/start → подсказка');
assert.deepEqual(parseBrainCommand('/входящиеее'), { action: 'help' }, 'опечатка → подсказка, а не запись');
assert.equal(parseBrainCommand('входящие лиды растут'), null, 'без косой черты — это идея, её надо записать');

// ── Хранилище на временной папке ─────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
const inboxPath = path.join(dir, INBOX_FILE);
const materialsDir = path.join(dir, MATERIALS_SUBDIR);
fs.writeFileSync(path.join(dir, '00-brand.md'), '# О бренде\n<!-- подсказка -->\n');

const TOKEN = '123456:SECRET-TOKEN';
const fakeApi = (calls = []) => ({
  getFile: async (fileId) => {
    calls.push(fileId);
    return { file_path: `photos/${fileId}.jpg` };
  },
});
const okFetch = (body) => async (url) => {
  assert.ok(url.includes(TOKEN), 'ссылка скачивания строится с токеном бота');
  return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
};

// Слота нет → пустой мозг не видит «Входящих» вовсе.
let bb = await loadBrandBrain(dir);
assert.equal(bb.filled, 0, 'до первой записи мозг бренда пуст');

// Фото БЕЗ подписи — самая коварная запись: будь она заголовком, слот считался бы пустым.
const inbox = createBrainInbox({ inboxPath, materialsDir, fetchImpl: okFetch('JPEGDATA') });
const calls = [];
const saved = await inbox.addMaterial({ api: fakeApi(calls), token: TOKEN, media: photo, messageId: 9, now });
assert.equal(saved.ok, true, 'фото сохранено');
assert.equal(saved.file, 'materials/20260910-143205-9-photo.jpg', 'путь в каталоге — относительно brand-brain/');
assert.equal(fs.readFileSync(path.join(dir, saved.file), 'utf8'), 'JPEGDATA', 'байты файла записаны');
assert.deepEqual(calls, ['big'], 'качается самый крупный размер фото');
assert.equal(fs.readFileSync(inboxPath, 'utf8').startsWith(INBOX_TEMPLATE), true, 'слот создан из шаблона');

bb = await loadBrandBrain(dir);
assert.equal(bb.filled, 1, 'фото без подписи всё равно делает слот «Входящие» заполненным');
assert.ok(bb.text.includes('materials/20260910-143205-9-photo.jpg'), 'агент видит строку каталога');
assert.ok(!bb.text.includes('README'), 'materials/README.md агентам не подмешивается');

// Идея и референс.
const idea = await inbox.addIdea({ text: 'Хотим рубрику «разбор ошибок клиентов»', now });
assert.equal(idea.entries, 2, 'вторая запись');
const ref = await inbox.addIdea({ text: 'Вот так надо писать', forwardedFrom: '@brand, https://t.me/brand/42', now });
assert.equal(ref.kind, 'референс', 'пересланное — это референс');
bb = await loadBrandBrain(dir);
assert.ok(bb.text.includes('разбор ошибок клиентов') && bb.text.includes('(переслано: @brand'), 'агент видит идею и источник референса');

// Параллельные записи (альбом) не перемешивают строки.
await Promise.all([1, 2, 3, 4, 5].map((n) => inbox.addIdea({ text: `параллель ${n}`, now })));
const after = fs.readFileSync(inboxPath, 'utf8');
assert.equal(parseEntries(after).length, 8, 'все пять параллельных записей на месте');
assert.ok(!after.includes('\n\n\n'), 'без лишних пустых строк');

// Тяжелее 20 МБ: файл не качается вовсе, подпись сохраняется.
const noCalls = [];
const big = await inbox.addMaterial({
  api: fakeApi(noCalls),
  token: TOKEN,
  media: { kind: 'видео', fileId: 'huge', size: TG_DOWNLOAD_LIMIT + 1, original: 'raw.mp4', defaultExt: '.mp4' },
  caption: 'Съёмка в студии, взять для Reels',
  messageId: 10,
  now,
});
assert.equal(big.ok, false, 'тяжёлое видео не принято');
assert.equal(big.tooBig && big.captionSaved, true, 'но подпись записана');
assert.deepEqual(noCalls, [], 'getFile даже не вызывался');
assert.ok(fs.readFileSync(inboxPath, 'utf8').includes('видео (файл не принят: больше 20 МБ)** — Съёмка в студии'), 'честная пометка в записи');

// Размер заранее неизвестен, а Telegram по факту ответил «file is too big» — подпись всё равно бережём.
const lateBig = await inbox.addMaterial({
  api: { getFile: async () => { throw new Error("Call to 'getFile' failed! (400: Bad Request: file is too big)"); } },
  token: TOKEN,
  media: { kind: 'видео', fileId: 'nosize', size: null, original: '', defaultExt: '.mp4' },
  caption: 'Бэкстейдж со съёмки',
  messageId: 12,
  now,
});
assert.equal(lateBig.tooBig && lateBig.captionSaved, true, 'отказ по факту тоже сохраняет подпись');

// Ошибка скачивания: запись не появляется, токен в текст ошибки не попадает.
const brokenInbox = createBrainInbox({
  inboxPath,
  materialsDir,
  fetchImpl: async () => ({ ok: false, status: 404 }),
});
const before = parseEntries(fs.readFileSync(inboxPath, 'utf8')).length;
const broken = await brokenInbox.addMaterial({ api: fakeApi(), token: TOKEN, media: photo, messageId: 11, now });
assert.equal(broken.ok, false, 'скачивание не удалось');
assert.ok(!String(broken.error).includes('SECRET'), `токен не утёк в ошибку: ${broken.error}`);
assert.equal(parseEntries(fs.readFileSync(inboxPath, 'utf8')).length, before, 'несохранённый файл не попадает в каталог');

// «/входящие».
const sum = await inbox.summary();
assert.equal(sum.files, 1, 'в materials/ один файл (README не считается)');
const sumText = renderInboxSummary(sum, { last: 3 });
assert.ok(sumText.includes('записей: 10') && sumText.includes('Последние 3:'), 'сводка: сколько и последние');
assert.ok(!sumText.includes('**'), 'в Telegram без markdown-звёздочек');
assert.ok(renderInboxSummary({ entries: [], chars: 0, files: 0 }).includes('пусты'), 'пустые «Входящие»');

// ── Тексты ответов ──────────────────────────────────────────────────────────────────────
assert.equal(inboxSizeWarning(INBOX_WARN_CHARS - 1), '', 'до порога — без предупреждения');
assert.ok(inboxSizeWarning(INBOX_WARN_CHARS).includes('разрослись'), 'после порога — просим разгрести');
assert.ok(renderIdeaReply({ kind: 'идея', entries: 3, chars: 100 }).startsWith('✅ Записал'), 'ответ на идею');

const albumText = renderMaterialReply([
  { ok: true, kind: 'фото', file: 'materials/a.jpg', bytes: 1, hasCaption: false },
  { ok: true, kind: 'фото', file: 'materials/b.jpg', bytes: 1, hasCaption: false },
  { ok: true, kind: 'видео', file: 'materials/c.mp4', bytes: 1, hasCaption: false },
]);
assert.ok(albumText.includes('3 файл(ов): фото ×2, видео ×1'), `альбом одной строкой: ${albumText}`);
assert.ok(albumText.includes('Подписи нет'), 'без подписи — подсказка');
assert.ok(!renderMaterialReply([{ ok: true, kind: 'фото', file: 'x', bytes: 1, hasCaption: true }]).includes('Подписи нет'), 'с подписью — без подсказки');
assert.ok(renderMaterialReply([big]).includes('больше 20 МБ') && renderMaterialReply([big]).includes('Подпись записал'), 'отказ по размеру объяснён');

// ── Альбом: один ответ на всю пачку ──────────────────────────────────────────────────────
const flushed = [];
const albums = createAlbumCollector({ delayMs: 20, onFlush: (ctx, results) => flushed.push({ ctx, n: results.length }) });
albums.start('g1', 'ctx1');
albums.start('g1', 'ctx2');
albums.done('g1', { ok: true });
await new Promise((r) => setTimeout(r, 40));
assert.equal(flushed.length, 0, 'пока часть альбома качается — не отвечаем');
albums.done('g1', { ok: true });
albums.start('g1', 'ctx3'); // следующая часть пришла до истечения паузы
albums.done('g1', { ok: true });
await new Promise((r) => setTimeout(r, 60));
assert.deepEqual(flushed, [{ ctx: 'ctx1', n: 3 }], 'три части альбома → один ответ в чат первой части');

// ── Бот в реестре ───────────────────────────────────────────────────────────────────────
const [brainBot] = enabledIdentities({ BOT_TOKEN_BRAIN: 'x', TOPIC_BRAIN: '321' });
assert.equal(brainBot?.key, 'brain', 'бот поднимается по BOT_TOKEN_BRAIN');
assert.equal(brainBot.agent, null, 'claude -p он не зовёт');
assert.equal(shouldHandle(brainBot, { chat: { type: 'supergroup' }, message: { message_thread_id: 321 } }), true, 'свой топик');
assert.equal(shouldHandle(brainBot, { chat: { type: 'supergroup' }, message: { message_thread_id: 7 } }), false, 'чужой топик');

fs.rmSync(dir, { recursive: true, force: true });
console.log('✓ smoke-brain PASS — идеи и файлы доходят до мозга бренда, агенты их видят');
