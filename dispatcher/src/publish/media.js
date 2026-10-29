// Картинки для Instagram: локальный PNG → публичный HTTPS-URL (T12).
//
// ГЛАВНОЕ, ЧЕГО НЕ ОБОЙТИ: Instagram Graph API не принимает файл. Он принимает `image_url` и
// СКАЧИВАЕТ картинку своими серверами. Значит, отрендеренный в T10 PNG обязан лежать в вебе:
// без публичной ссылки карусель не опубликуется даже с идеально настроенным токеном.
//
// Отсюда два обязательных параметра установки:
//   PUBLIC_DIR      — папка, которую раздаёт Nginx (та самая статика из архитектуры на VPS);
//   PUBLIC_BASE_URL — по какому адресу эта папка видна снаружи.
//
// Копируем, а не «отдаём путь как есть»: data/renders живёт рядом с БД и наружу не смотрит,
// а публикуемое должно лежать в веб-корне явно и осознанно.

import fs from 'node:fs';
import path from 'node:path';

/** Готова ли выкладка картинок в веб. */
export function mediaReady(config) {
  if (!config?.publicDir || !config?.publicBaseUrl) {
    return {
      ok: false,
      error:
        'нет публичной статики: задай PUBLIC_DIR (папка Nginx) и PUBLIC_BASE_URL. Instagram ' +
        'скачивает картинку по ссылке сам — локальный файл он не примет',
    };
  }
  return { ok: true };
}

/**
 * Выкладывает файлы в публичную папку и возвращает их URL.
 * @param {object} o
 * @param {string[]} o.files  локальные пути к картинкам (meta.images из T10)
 * @param {object} o.config   конфиг диспетчера (publicDir, publicBaseUrl)
 * @param {string} o.subdir   подпапка внутри публичной статики (обычно queue-<id>)
 * @param {Function} [o.nameOf]  как назвать файл в вебе (default: как называется локально).
 *   Нужен ролику из T15: его имя приходит с ноута клиента и может быть с пробелами и кириллицей,
 *   а такое имя в URL Meta не заберёт.
 * @returns {{urls:string[], dir:string}}
 */
export function publishFiles({ files, config, subdir, fsImpl = fs, nameOf = (f) => path.basename(f) }) {
  const ready = mediaReady(config);
  if (!ready.ok) throw new Error(ready.error);

  const targetDir = path.join(config.publicDir, subdir);
  fsImpl.mkdirSync(targetDir, { recursive: true });

  const urls = [];
  for (const file of files) {
    const name = nameOf(file);
    fsImpl.copyFileSync(file, path.join(targetDir, name));
    urls.push(`${String(config.publicBaseUrl).replace(/\/+$/, '')}/${encodeURI(`${subdir}/${name}`)}`);
  }
  return { urls, dir: targetDir };
}

/**
 * Картинки элемента очереди → публичные URL.
 * Если агент уже дал готовые ссылки (meta.image_urls) — берём их и ничего не копируем.
 * @returns {{urls:string[], source:'meta'|'copied'}}
 */
export function imageUrlsFor({ item, config, fsImpl = fs }) {
  const ready = Array.isArray(item?.meta?.image_urls)
    ? item.meta.image_urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    : [];
  if (ready.length) return { urls: ready, source: 'meta' };

  const files = localImages(item?.meta);
  if (!files.length) return { urls: [], source: 'copied' };

  const { urls } = publishFiles({ files, config, subdir: `queue-${item.id}`, fsImpl });
  return { urls, source: 'copied' };
}

/** Локальные пути картинок из meta (их кладёт рендер T10). */
export function localImages(meta) {
  const list = Array.isArray(meta?.images) ? meta.images : [];
  const single = typeof meta?.photo === 'string' ? [meta.photo] : [];
  return (list.length ? list : single).filter((f) => typeof f === 'string' && f.trim() && !/^https?:\/\//i.test(f));
}
