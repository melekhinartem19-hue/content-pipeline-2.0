// Приём готового ролика с ноута клиента в очередь согласования (T15, VPS-сторона).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ПУТЬ. Монтаж живёт на ноуте клиента (двухмозговая архитектура из CLAUDE.md):
// исходники весят десятки и сотни мегабайт, а Telegram Bot API качает файлы только до 20 МБ —
// занести материал через бота нельзя. Поэтому смонтированный ЛЁГКИЙ ролик приезжает на VPS сам,
// минуя Telegram, и встаёт в ту же очередь согласования, что тексты и картинки: владелец жмёт
// «Одобрить» в топике Издателя, и дальше отрабатывает уже готовая IG-публикация (T12).
//
// ПОЧЕМУ CLI, А НЕ ВЕБ-ХУК. Диспетчер не слушает входящих соединений — портов наружу не
// открываем (то же решение, что и в воронке ManyChat, T14: система остаётся закрытой).
// Доставка идёт по SSH тем же ключом, которым клиент и так заходит на сервер: `scp` кладёт файл,
// а `npm run ingest:video` на VPS регистрирует его в очереди. Новых точек входа не появляется.
//
// ПОЧЕМУ ФАЙЛ КОПИРУЕТСЯ В ПУБЛИЧНУЮ СТАТИКУ. Instagram не принимает файл: Graph API берёт
// `video_url` и качает ролик своими серверами — тот же закон, что и для картинок (publish/media.js).
// Значит ролик обязан лежать в веб-корне Nginx и иметь https-адрес. Без PUBLIC_DIR/PUBLIC_BASE_URL
// приём бессмыслен, и мы отказываемся ЕЩЁ ДО копирования, а не после — чтобы на диске VPS не
// оставалось файлов, которые всё равно некому отдать.

import fs from 'node:fs';
import path from 'node:path';
import { config as globalConfig } from '../config.js';
import { mediaReady, publishFiles } from '../publish/media.js';
import { enqueueDraft } from '../queue/approval.js';

/** Вид контента: готовый ролик (в отличие от `reels_script` — сценария без видео). */
export const VIDEO_KIND = 'reels_video';

/** Автор черновика. Своего бота у видео на VPS нет (7-й агент — это T16), но автор в карточке нужен. */
export const VIDEO_AGENT = 'video';

/** Что принимает Instagram как Reels. Всё остальное он отвергнет уже после заливки — режем раньше. */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov']);

/**
 * Имя ролика в вебе: метка времени + безопасное имя файла.
 * Пробелы и кириллица в URL — источник битых ссылок у Meta, поэтому имя чистится; метка времени
 * делает его уникальным, чтобы новый ролик не затёр уже опубликованный по тому же адресу.
 */
export function publicVideoName(file, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ext = path.extname(file).toLowerCase();
  const base =
    path
      .basename(file, path.extname(file))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'reels';
  return `${stamp}-${base}${ext}`;
}

/**
 * Проверяет файл ДО копирования: существует, это видео, размер разумный.
 * @returns {{ok:boolean, bytes?:number, error?:string}}
 */
export function checkVideoFile(file, { fsImpl = fs, maxBytes = globalConfig.videoMaxBytes } = {}) {
  const target = String(file || '').trim();
  if (!target) return { ok: false, error: 'не указан файл ролика' };

  let stat;
  try {
    stat = fsImpl.statSync(target);
  } catch {
    return { ok: false, error: `файла нет: ${target}` };
  }
  if (!stat.isFile()) return { ok: false, error: `это не файл: ${target}` };

  const ext = path.extname(target).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: `Instagram принимает Reels как MP4 или MOV, а тут «${ext || 'без расширения'}» — перекодируй ролик`,
    };
  }
  if (stat.size <= 0) return { ok: false, error: 'файл пустой — похоже, копирование не доехало' };
  if (stat.size > maxBytes) {
    const mb = (n) => Math.round(n / (1024 * 1024));
    return {
      ok: false,
      error:
        `ролик ${mb(stat.size)} МБ, а потолок ${mb(maxBytes)} МБ (VIDEO_MAX_MB). На VPS приезжает ` +
        'готовый лёгкий ролик, а не исходники — пережми на ноуте или подними лимит осознанно',
    };
  }
  return { ok: true, bytes: stat.size };
}

/**
 * Принимает смонтированный ролик: выкладывает его в публичную статику и ставит в очередь
 * согласования карточкой в топике Издателя.
 *
 * Подпись кладётся в `meta.caption` — Instagram берёт её именно оттуда, а не из `content`
 * (см. гочу в CLAUDE.md). В `content` тот же текст лежит для карточки: владелец должен видеть,
 * что именно уедет под роликом.
 *
 * @param {object} o
 * @param {object} o.db  фасад БД
 * @param {string} o.file  путь к готовому ролику на VPS (его туда положил scp с ноута)
 * @param {string} [o.caption]  подпись к Reels
 * @param {string} [o.title]  тема/название — видно в карточке и в «/очередь»
 * @param {string} [o.slotAt]  слот контент-календаря `YYYY-MM-DD HH:MM` (публикация отложится)
 * @param {Map<string,{bot:object, identity:object}>} o.botsByKey  поднятые боты (нужен Издатель)
 * @param {number|string} o.groupId  форум-группа
 * @returns {Promise<{ok:boolean, id?:number, url?:string, name?:string, bytes?:number,
 *   messageId?:number|null, cardError?:string, error?:string}>}
 */
export async function ingestVideo({
  db,
  file,
  caption = '',
  title = null,
  slotAt = null,
  botsByKey,
  groupId,
  publisherKey = 'publisher',
  config = globalConfig,
  fsImpl = fs,
  now = new Date(),
}) {
  const ready = mediaReady(config);
  if (!ready.ok) {
    return {
      ok: false,
      error:
        `${ready.error}. Для ролика это тем более обязательно: Reels публикуется по video_url, ` +
        'файл Instagram не примет',
    };
  }

  const check = checkVideoFile(file, { fsImpl, maxBytes: config.videoMaxBytes });
  if (!check.ok) return { ok: false, error: check.error };

  const name = publicVideoName(file, now);
  const { urls } = publishFiles({
    files: [file],
    config,
    subdir: config.videoPublicSubdir,
    fsImpl,
    nameOf: () => name,
  });
  const url = urls[0];

  const text = String(caption || '').trim();
  const publisher = botsByKey?.get(publisherKey);
  const { id, messageId, error } = await enqueueDraft({
    db,
    bot: publisher?.bot,
    groupId,
    topicId: publisher?.identity?.topicId ?? null,
    draft: {
      platform: 'ig',
      agent: VIDEO_AGENT,
      kind: VIDEO_KIND,
      title: title ? String(title).trim() : null,
      // Пустая подпись — законный случай (Reels без текста), но в карточке это должно быть видно.
      content: text || '(без подписи — ролик уйдёт в Instagram без текста)',
      meta: {
        video_url: url,
        caption: text,
        source: 'laptop', // приехал с ноута клиента, а не от агента на VPS
        file: name,
        bytes: check.bytes,
      },
    },
  });

  if (slotAt) db.queue.setSlot(id, slotAt);

  return { ok: true, id, url, name, bytes: check.bytes, messageId, cardError: error };
}

/** Отчёт для консоли на VPS: его читает и человек, и локальный Claude Code с ноута. */
export function renderIngestReport(res) {
  if (!res.ok) return `✗ ролик не принят: ${res.error}`;
  const mb = (res.bytes / (1024 * 1024)).toFixed(1);
  return [
    `✓ ролик принят: черновик #${res.id} (${mb} МБ)`,
    `ссылка: ${res.url}`,
    res.messageId
      ? 'карточка с кнопками висит в топике Издателя — публикация после «Одобрить»'
      : `карточку показать не удалось (${res.cardError || 'нет топика Издателя'}); черновик найдётся через «/очередь»`,
  ].join('\n');
}
