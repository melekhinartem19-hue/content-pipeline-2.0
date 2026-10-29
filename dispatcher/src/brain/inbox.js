// «Мозг бренда» — бот-приёмник идей и материалов клиента (T18).
//
// Клиент пишет в топик «Мозг бренда» идеи, пересылает понравившиеся посты, кидает фото, видео и
// файлы. Диспетчер складывает всё это в brand-brain/ — туда, откуда каждый агент читает контекст
// перед КАЖДОЙ задачей. Отдельный шаг «передать агентам» не нужен: запись во «Входящие» и есть
// передача.
//
// ПОЧЕМУ БЕЗ claude -p (решение владельца 10.09.2026). Идея дописывается как есть, с датой, в слот
// 09-inbox.md. Раскладывать каждое сообщение агентом по слотам — это вызов на каждое «а ещё вот
// что» и риск, что агент перепишет не тот слот. Разнести накопленное по слотам 00–08 можно позже,
// одним осознанным шагом.
//
// ПОЧЕМУ ФАЙЛЫ — КАТАЛОГОМ. Агент — это один проход `claude -p` с текстовым промптом: картинку,
// видео или PDF он не видит. Поэтому файл кладётся в brand-brain/materials/, а во «Входящие»
// попадает строка каталога: вид, путь, подпись. Подпись — единственное, что агент узнает о файле.
//
// ПОЧЕМУ 20 МБ. Bot API не отдаёт ботам файлы тяжелее 20 МБ (правило 5 в CLAUDE.md) — это
// устройство Telegram, обойти его нельзя. Тяжёлое видео и так живёт на ноуте клиента, где монтаж.
//
// Модуль не знает о grammY и о config.js: пути, Telegram-api и fetch приходят параметрами —
// так смоук проверяет его без сети и без настоящего бота.

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Слот «Входящих» в brand-brain/. Номер 09 — после всех тематических слотов 00–08. */
export const INBOX_FILE = '09-inbox.md';

/** Подпапка brand-brain/ для файлов клиента. loadBrandBrain её не читает: он берёт только *.md корня. */
export const MATERIALS_SUBDIR = 'materials';

/** Потолок Bot API на скачивание файла ботом. */
export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/**
 * Сколько ждать скачивания одного файла. grammY разбирает обновления строго по очереди: зависшая
 * загрузка без тайм-аута держала бы весь бот «Мозг бренда» глухим, пока не сдастся сама сеть.
 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Порог, после которого бот просит разгрести «Входящие». Слот читается целиком каждым агентом перед
 * каждой задачей: 15 тыс. знаков — это уже заметная прибавка к каждому вызову claude -p на Pro-подписке.
 */
export const INBOX_WARN_CHARS = 15_000;

/** Шаблон слота: создаётся сам при первой записи, если файла нет (например, на сервере его не выкладывали). */
export const INBOX_TEMPLATE = [
  '# Входящие от клиента',
  '',
  '<!-- Сюда бот «Мозг бренда» сам дописывает всё, что клиент прислал в свой топик: идеи, пересланные',
  '     посты (референсы), подписи к фото, видео и файлам. Сами файлы лежат рядом, в materials/.',
  '     Агенты читают этот слот перед каждой задачей, как и остальные. Когда записей станет много —',
  '     перенесите главное в тематические слоты 00–08, а отсюда удалите: слот читается целиком. -->',
  '',
].join('\n');

const p2 = (n) => String(n).padStart(2, '0');

/** Метка записи во «Входящих»: `YYYY-MM-DD HH:MM` по часам сервера. */
export function entryStamp(now = new Date()) {
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
}

function fileStamp(now) {
  return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
}

/** Имя файла по умолчанию, если Telegram его не прислал (у фото имени нет никогда). */
const KIND_SLUG = { фото: 'photo', видео: 'video', аудио: 'audio', файл: 'file' };

/**
 * Имя файла в materials/: метка времени + id сообщения + очищенное исходное имя.
 *
 * id сообщения обязателен: альбом из пяти фото приходит в одну секунду, и одной метки времени
 * не хватило бы — файлы затирали бы друг друга. Кириллица в имени остаётся: эти файлы читает
 * человек, в публичные ссылки они не идут. Путь из имени выбрасывается целиком — «../../.env»
 * превращается в безобидное «env».
 */
export function materialFileName({ original = '', kind = 'файл', messageId = 0, defaultExt = '', now = new Date() }) {
  const leaf = String(original || '').split(/[\\/]/).pop() || '';
  // Кириллица в расширении («отчёт.пдф») тоже остаётся: иначе от него оставалась бы голая точка,
  // а имя с точкой на конце Windows молча обрезает — и строка каталога не совпала бы с файлом.
  const cleanExt = (e) => String(e || '').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '').slice(0, 10);
  const own = cleanExt(path.extname(leaf));
  const ext = own.length > 1 ? own : cleanExt(defaultExt);
  const base =
    leaf
      .slice(0, leaf.length - path.extname(leaf).length)
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || KIND_SLUG[kind] || 'file';
  return `${fileStamp(now)}-${Number(messageId) || 0}-${base}${ext}`;
}

/** Расширение по MIME — для видео и аудио без имени файла. */
function extFromMime(mime) {
  const known = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
  };
  return known[String(mime || '').toLowerCase()] || '';
}

/**
 * Что именно прислали: вид, file_id, размер и исходное имя. null — в сообщении нет файла,
 * который мы храним (голосовые обрабатываются отдельно: их агент не услышит).
 *
 * У анимаций (GIF) Telegram заполняет и `animation`, и `document` — они сохраняются как файл.
 */
export function describeMedia(msg = {}) {
  if (msg.photo?.length) {
    const best = msg.photo[msg.photo.length - 1]; // размеры идут по возрастанию, последний — оригинал
    return { kind: 'фото', fileId: best.file_id, size: best.file_size ?? null, original: '', defaultExt: '.jpg' };
  }
  if (msg.video) {
    const v = msg.video;
    return { kind: 'видео', fileId: v.file_id, size: v.file_size ?? null, original: v.file_name || '', defaultExt: extFromMime(v.mime_type) || '.mp4' };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return { kind: 'видео', fileId: v.file_id, size: v.file_size ?? null, original: '', defaultExt: '.mp4' };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { kind: 'аудио', fileId: a.file_id, size: a.file_size ?? null, original: a.file_name || '', defaultExt: extFromMime(a.mime_type) || '.mp3' };
  }
  if (msg.document) {
    const d = msg.document;
    return { kind: 'файл', fileId: d.file_id, size: d.file_size ?? null, original: d.file_name || '', defaultExt: '' };
  }
  return null;
}

/**
 * Откуда переслано сообщение — для референсов. Пост публичного канала получает ссылку: по ней
 * агент (и человек) найдёт первоисточник. null — сообщение не пересланное.
 */
export function forwardLabel(origin) {
  if (!origin) return null;
  if (origin.type === 'channel') {
    const u = origin.chat?.username;
    if (u) return origin.message_id ? `@${u}, https://t.me/${u}/${origin.message_id}` : `@${u}`;
    return origin.chat?.title || 'канал';
  }
  if (origin.type === 'chat') return origin.sender_chat?.title || 'чат';
  if (origin.type === 'user') {
    const u = origin.sender_user;
    return u?.username ? `@${u.username}` : u?.first_name || 'пользователь';
  }
  if (origin.type === 'hidden_user') return origin.sender_user_name || 'пользователь';
  return 'пересланное сообщение';
}

/**
 * Одна запись «Входящих». Это пункт списка, а не заголовок: loadBrandBrain считает заголовки
 * разметкой шаблона, и фото без подписи, записанное заголовком, сделало бы слот «пустым».
 * Продолжения многострочного текста сдвинуты на два пробела — так строка клиента, начатая с «#»,
 * не притворится заголовком.
 */
export function formatEntry({ kind = 'идея', text = '', file = null, forwardedFrom = null, now = new Date() }) {
  let head = `- **${entryStamp(now)} · ${kind}**`;
  if (file) head += ` \`${file}\``;
  if (forwardedFrom) head += ` (переслано: ${forwardedFrom})`;

  const body = String(text || '').trim();
  if (!body) return `${head}\n`;
  const [first, ...rest] = body.split(/\r?\n/);
  return [`${head} — ${first}`, ...rest.map((line) => (line.trim() ? `  ${line}` : ''))].join('\n') + '\n';
}

/** Записи «Входящих» по одной (всё, что начинается с пункта списка с меткой времени). */
export function parseEntries(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^- \*\*\d{4}-\d{2}-\d{2} /.test(line)) entries.push(line);
    else if (entries.length && line.trim()) entries[entries.length - 1] += `\n${line}`;
  }
  return entries;
}

/**
 * Скачивает файл из Telegram в dest. Ссылка на скачивание содержит токен бота — поэтому в
 * текст ошибки она не попадает никогда: ошибки уходят в топик и в журнал.
 * @returns {Promise<number>} размер записанного файла в байтах
 */
export async function downloadTelegramFile({
  api,
  token,
  fileId,
  dest,
  fetchImpl = fetch,
  fsImpl = fsp,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
}) {
  const file = await api.getFile(fileId);
  if (!file?.file_path) throw new Error('Telegram не отдал путь к файлу');

  let buf;
  try {
    const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Telegram отдал файл с ошибкой HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`Telegram не отдал файл за ${Math.round(timeoutMs / 1000)} с`);
    throw err;
  }
  await fsImpl.mkdir(path.dirname(dest), { recursive: true });
  await fsImpl.writeFile(dest, buf);
  return buf.length;
}

/**
 * Хранилище «Входящих» и материалов.
 *
 * Запись в файл идёт строго по одной: альбом — это пачка сообщений, и параллельные дописывания
 * могли бы перемешать строки. Скачивание файлов в эту очередь не входит — ждать его незачем.
 *
 * @param {object} o
 * @param {string} o.inboxPath     полный путь к 09-inbox.md
 * @param {string} o.materialsDir  полный путь к brand-brain/materials
 */
export function createBrainInbox({ inboxPath, materialsDir, fsImpl = fsp, fetchImpl = fetch }) {
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const readInbox = async () => {
    try {
      return await fsImpl.readFile(inboxPath, 'utf8');
    } catch {
      return null;
    }
  };

  /** Дописывает запись, создавая слот из шаблона при необходимости. Возвращает размер слота. */
  const append = (entry) =>
    serial(async () => {
      let current = await readInbox();
      if (current === null) {
        await fsImpl.mkdir(path.dirname(inboxPath), { recursive: true });
        await fsImpl.writeFile(inboxPath, INBOX_TEMPLATE, 'utf8');
        current = INBOX_TEMPLATE;
      }
      // Первая запись отделяется от шаблона пустой строкой, дальше записи идут подряд.
      const sep = parseEntries(current).length ? (current.endsWith('\n') ? '' : '\n') : current.endsWith('\n\n') ? '' : '\n';
      await fsImpl.appendFile(inboxPath, sep + entry, 'utf8');
      const after = current + sep + entry;
      return { chars: after.length, entries: parseEntries(after).length };
    });

  return {
    /** Текстовая идея или пересланный пост (тогда вид «референс»). */
    async addIdea({ text, forwardedFrom = null, now = new Date() }) {
      const kind = forwardedFrom ? 'референс' : 'идея';
      const stats = await append(formatEntry({ kind, text, forwardedFrom, now }));
      return { ok: true, kind, ...stats };
    },

    /**
     * Файл: скачать в materials/ и записать строку каталога. Слишком тяжёлый файл не качается
     * вовсе, но подпись к нему сохраняется — в ней обычно и есть мысль клиента.
     */
    async addMaterial({ api, token, media, caption = '', messageId = 0, forwardedFrom = null, now = new Date() }) {
      const text = String(caption || '').trim();

      // Отказ по размеру — одинаковый, узнали ли о нём заранее (file_size) или по факту от Telegram.
      const refuseTooBig = async () => {
        const base = { ok: false, kind: media.kind, tooBig: true, bytes: media.size ?? null, captionSaved: false };
        if (!text) return base;
        const stats = await append(
          formatEntry({ kind: `${media.kind} (файл не принят: больше 20 МБ)`, text, forwardedFrom, now }),
        );
        return { ...base, captionSaved: true, ...stats };
      };

      if (media.size != null && media.size > TG_DOWNLOAD_LIMIT) return refuseTooBig();

      const name = materialFileName({ original: media.original, kind: media.kind, messageId, defaultExt: media.defaultExt, now });
      const rel = `${MATERIALS_SUBDIR}/${name}`;
      const dest = path.join(materialsDir, name);
      let bytes;
      try {
        bytes = await downloadTelegramFile({ api, token, fileId: media.fileId, dest, fetchImpl, fsImpl });
      } catch (err) {
        // «file is too big» прилетает, если Telegram не прислал размер заранее — подпись всё равно бережём.
        if (/too big/i.test(String(err?.message))) return refuseTooBig();
        return { ok: false, kind: media.kind, tooBig: false, error: err.message, captionSaved: false };
      }

      let stats;
      try {
        stats = await append(formatEntry({ kind: media.kind, text, file: rel, forwardedFrom, now }));
      } catch (err) {
        // Файл скачан, а строку каталога записать не вышло: клиенту ответим «пришли ещё раз», и
        // без уборки в materials/ осталась бы копия, о которой не знают ни агенты, ни «Входящие».
        await fsImpl.unlink?.(dest).catch(() => {});
        throw err;
      }
      return { ok: true, kind: media.kind, file: rel, bytes, hasCaption: Boolean(text), ...stats };
    },

    /** Состояние для «/входящие»: записи, размер слота, число файлов в materials/. */
    async summary() {
      const text = (await readInbox()) ?? '';
      let files = 0;
      try {
        files = (await fsImpl.readdir(materialsDir)).filter((f) => f.toLowerCase() !== 'readme.md').length;
      } catch {
        files = 0; // папки ещё нет — ничего не присылали
      }
      return { entries: parseEntries(text), chars: text.length, files };
    },
  };
}

/**
 * Альбом приходит пачкой отдельных сообщений с общим media_group_id. Отвечать на каждое — значит
 * засыпать топик, поэтому итоги копятся и отдаются одним вызовом, когда всё скачано и новых
 * частей альбома не приходит `delayMs`.
 *
 * Счётчик «в работе» нужен потому, что скачивание долгое: без него альбом из тяжёлых видео
 * разваливался бы на несколько ответов.
 */
export function createAlbumCollector({ delayMs = 1500, onFlush }) {
  const groups = new Map();
  return {
    start(id, ctx) {
      const g = groups.get(id) ?? { pending: 0, results: [], ctx, timer: null };
      groups.set(id, g);
      g.pending += 1;
      clearTimeout(g.timer);
    },
    done(id, result) {
      const g = groups.get(id);
      if (!g) return;
      g.pending -= 1;
      g.results.push(result);
      clearTimeout(g.timer);
      if (g.pending > 0) return;
      g.timer = setTimeout(() => {
        groups.delete(id);
        Promise.resolve(onFlush(g.ctx, g.results)).catch((err) => console.error('[brain] ответ по альбому:', err.message));
      }, delayMs);
    },
  };
}

// ── Команды и тексты ответов ───────────────────────────────────────────────────────────

/**
 * Команда в топике «Мозг бренда». Без косой черты команды нет: «входящие лиды растут» — это идея,
 * и она должна записаться, а не превратиться в запрос списка.
 * @returns {{action:'list'|'help'}|null}  null — обычный текст, его записываем
 */
export function parseBrainCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return null;
  // (?:@\S+)? — форма «/входящие@бот», которую Telegram подставляет в группах.
  if (/^\/(входящие|inbox|список)(?:@\S+)?(?![\p{L}\p{N}_])/iu.test(t)) return { action: 'list' };
  // Любая другая команда (/start, /помощь, опечатка) — подсказка. Во «Входящие» команды не пишем.
  return { action: 'help' };
}

export const BRAIN_HELP = [
  '🧠 Я — «Мозг бренда». Всё, что пришлёшь сюда, агенты учтут в следующих задачах.',
  '',
  '• Текст — идея, факт, отзыв, мысль: записываю как есть.',
  '• Пересланный пост — сохраняю как референс с пометкой, откуда он.',
  '• Фото, видео, файлы до 20 МБ — кладу в материалы бренда.',
  '',
  'Подписывай файлы: агент видит подпись, а не саму картинку или видео.',
  'Голосовые не принимаю — агенты их не слышат, продублируй текстом.',
  '',
  '«/входящие» — что уже накопилось.',
].join('\n');

export const BRAIN_VOICE_HINT =
  '🎙 Голосовые агенты не слышат: модели на сервере приходит только текст. Продублируй мысль текстом — запишу.';

const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} МБ`;

/** Приписка о разросшихся «Входящих». Пусто, если всё в порядке. */
export function inboxSizeWarning(chars) {
  if (!chars || chars < INBOX_WARN_CHARS) return '';
  return (
    `\n⚠️ «Входящие» разрослись до ~${Math.round(chars / 1000)} тыс. знаков, а каждый агент читает их целиком ` +
    'перед каждой задачей. Пора перенести главное в слоты 00–08 и очистить 09-inbox.md.'
  );
}

/** Ответ на записанную идею. */
export function renderIdeaReply(res) {
  const what = res.kind === 'референс' ? 'Референс сохранил' : 'Записал';
  return `✅ ${what} во «Входящие» (записей: ${res.entries}). Агенты учтут это в следующей задаче.${inboxSizeWarning(res.chars)}`;
}

/** Ответ по одному файлу или по целому альбому. */
export function renderMaterialReply(results = []) {
  const saved = results.filter((r) => r.ok);
  const tooBig = results.filter((r) => !r.ok && r.tooBig);
  const failed = results.filter((r) => !r.ok && !r.tooBig);
  const lines = [];

  if (saved.length === 1) {
    lines.push(`📎 Сохранил ${saved[0].kind} (${mb(saved[0].bytes)}): ${saved[0].file}`);
  } else if (saved.length > 1) {
    const byKind = {};
    for (const r of saved) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const kinds = Object.entries(byKind).map(([k, n]) => `${k} ×${n}`).join(', ');
    lines.push(`📎 Сохранил ${saved.length} файл(ов): ${kinds} — в materials/`);
  }
  if (saved.length && !saved.some((r) => r.hasCaption)) {
    lines.push('ℹ️ Подписи нет — агенты увидят только имя файла. Напиши следующим сообщением, что это и зачем.');
  }

  for (const r of tooBig) {
    const size = r.bytes ? ` (${mb(r.bytes)})` : '';
    lines.push(
      `⚠️ ${r.kind}${size} не принято: Telegram не отдаёт ботам файлы больше 20 МБ. ` +
        'Пришли сжатую версию, а исходник оставь на ноуте — монтаж и так идёт там.' +
        (r.captionSaved ? ' Подпись записал во «Входящие».' : ''),
    );
  }
  for (const r of failed) lines.push(`⚠️ ${r.kind} не сохранилось: ${r.error}. Пришли ещё раз.`);

  const last = [...results].reverse().find((r) => r.chars);
  return lines.join('\n') + (last ? inboxSizeWarning(last.chars) : '');
}

/** Ответ на «/входящие»: сколько накопилось и последние записи (длинные — обрезаны). */
export function renderInboxSummary({ entries = [], chars = 0, files = 0 }, { last = 10 } = {}) {
  if (!entries.length) {
    return `🧠 «Входящие» пока пусты${files ? ` (файлов в materials/: ${files})` : ''}. Пиши идеи и кидай материалы прямо сюда.`;
  }
  const clip = (s) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
  const shown = entries.slice(-last);
  return [
    `🧠 Во «Входящих» записей: ${entries.length} · ~${(chars / 1000).toFixed(1)} тыс. знаков · файлов: ${files}`,
    '',
    entries.length > shown.length ? `Последние ${shown.length}:` : 'Все записи:',
    ...shown.map((e) => clip(e.replace(/\*\*/g, ''))),
  ].join('\n') + inboxSizeWarning(chars);
}
