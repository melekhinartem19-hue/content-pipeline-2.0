// Точка входа браузерной публикации (вариант C): её дёргает таблица PLATFORMS в publish/index.js.
//
// Отвечает за три вещи, которых нет в instagram.js и threads.js этой же папки: открыть браузер,
// убедиться, что сессия жива, и вернуть результат в том же виде, что возвращает API-путь —
// {ref, dryRun, plan, note, skip, reason}. Очередь не должна знать, каким способом ушёл пост.
//
// ── Почему браузер открывается и закрывается на КАЖДУЮ публикацию ───────────────────────────
// Постоянный профиль Chromium держит файловую блокировку на папке. Если диспетчер будет вечно
// держать браузер открытым, то `npm run ig:login` на том же сервере просто не запустится —
// профиль занят, а человек в этот момент как раз чинит вход. Публикации идут по очереди и
// редко, так что лишние секунды на старт браузера ничего не стоят.
//
// ── Автоматический вход здесь НЕ делается ───────────────────────────────────────────────────
// Если сессия умерла, мы честно отваливаемся с просьбой запустить `npm run ig:login`, а не
// логинимся молча. Причина: вход почти наверняка потребует кода подтверждения, а спросить его
// в момент публикации не у кого — приём кода реплаем в топик Издателя делается отдельным шагом.
// Молчаливый повтор входа на каждой публикации — это ровно тот признак, по которому аккаунты
// и уезжают в блокировку.

import fs from 'node:fs';
import path from 'node:path';

import { localImages } from '../media.js';
import { pickCaption } from '../instagram.js';
import { openSession, sessionState } from './session.js';
import { postToInstagram, IG_CAPTION_LIMIT } from './instagram.js';
import { postToThreads } from './threads.js';

/** Границы карусели — ограничение Instagram, одинаковое для API и браузера. */
export const IG_CAROUSEL_MAX = 10;

/** Готова ли браузерная публикация. Проверяем настройку, а не живость сессии: это делает публикация. */
export function browserReady(config) {
  const missing = [!config?.igLogin && 'IG_LOGIN', !config?.igPassword && 'IG_PASSWORD'].filter(Boolean);
  if (missing.length) return { ok: false, error: `не задано в .env: ${missing.join(', ')}` };
  return { ok: true };
}

/** Снимок экрана при сбое — чтобы разбирать поломку по картинке, а не по догадкам. */
function shooter(shotsDir) {
  return async (page, name) => {
    if (!shotsDir) return null;
    try {
      fs.mkdirSync(shotsDir, { recursive: true });
      const file = path.join(shotsDir, `${name}-${Date.now()}.png`);
      await page.screenshot({ path: file });
      return file;
    } catch {
      return null;
    }
  };
}

/**
 * Локальный путь к ролику, приехавшему с ноута (T15).
 * Браузер грузит ФАЙЛ, поэтому публичная ссылка здесь бесполезна — нужен путь на диске.
 */
function localVideo(item, config) {
  const name = item?.meta?.file;
  if (!name || !config?.publicDir) return null;
  const file = path.join(config.publicDir, config.videoPublicSubdir || 'video', name);
  return fs.existsSync(file) ? file : null;
}

/** План действий для сухого прогона: что бы сделал браузер, если бы его пустили. */
function planFor({ platform, files, caption, text }) {
  if (platform === 'threads') {
    return [
      { method: 'BROWSER', url: 'threads.com → открыть окно нового поста' },
      { method: 'BROWSER', url: `вписать текст (${text.length} знаков)` },
      { method: 'BROWSER', url: 'нажать «Post»' },
    ];
  }
  return [
    { method: 'BROWSER', url: 'instagram.com → «Создать»' },
    { method: 'BROWSER', url: `загрузить файлов: ${files.length}` },
    { method: 'BROWSER', url: 'пройти шаги мастера до поля подписи' },
    { method: 'BROWSER', url: `вписать подпись (${caption.length} знаков)` },
    { method: 'BROWSER', url: 'нажать «Поделиться»' },
  ];
}

/**
 * Публикует одобренный элемент очереди живым браузером.
 *
 * @param {object} o
 * @param {object} o.item    элемент очереди
 * @param {object} o.config
 * @param {Function} [o.log]
 * @returns {Promise<{ref?:string|null, dryRun?:boolean, plan?:object[], note?:string|null,
 *   skip?:boolean, reason?:string}>}
 */
export async function publishViaBrowser({ item, config, log = () => {} }) {
  const platform = item?.platform === 'threads' ? 'threads' : 'ig';

  // ── Что именно публикуем: собираем ДО открытия браузера ────────────────
  // Пустой пост, слишком длинный текст и отсутствующие картинки должны отваливаться
  // мгновенно и бесплатно, а не после тридцати секунд запуска Chromium.
  let files = [];
  let caption = '';
  let text = '';

  if (platform === 'threads') {
    text = String(item?.content || '').trim();
    if (!text) return { skip: true, reason: 'пустой текст — публиковать нечего' };
  } else {
    caption = pickCaption(item);
    if (caption.length > IG_CAPTION_LIMIT) {
      throw new Error(`подпись ${caption.length} знаков, а Instagram принимает ${IG_CAPTION_LIMIT} — сократи`);
    }

    const video = localVideo(item, config);
    if (item.kind === 'reels_script' || item?.meta?.video_url) {
      if (!video) {
        return {
          skip: true,
          reason: item?.meta?.video_url
            ? 'ролик есть только публичной ссылкой, а браузеру нужен файл на диске. ' +
              'Проверь PUBLIC_DIR и что файл ещё лежит в статике'
            : 'это сценарий Reels, а не готовый ролик: публиковать нечего. Ролик монтируется на ноуте клиента (T15)',
        };
      }
      files = [video];
    } else {
      files = localImages(item?.meta).filter((f) => fs.existsSync(f));
      if (!files.length) {
        return {
          skip: true,
          reason: 'нет картинок на диске: сначала рендер (T10). Повторить — «/рендер <id>» в топике Дизайнера',
        };
      }
      if (files.length > IG_CAROUSEL_MAX) {
        // Молча обрезать нельзя: владелец одобрил конкретный набор кадров.
        throw new Error(`кадров ${files.length}, а карусель Instagram принимает не больше ${IG_CAROUSEL_MAX}`);
      }
    }
  }

  const plan = planFor({ platform, files, caption, text });

  // Сухой прогон: браузер даже не запускаем — показываем план и выходим.
  if (config.publishDryRun) return { dryRun: true, plan, ref: null, note: null };

  const session = await openSession({ profileDir: config.igProfileDir, headless: !config.igHeadful });
  try {
    const state = await sessionState(session.context);
    const alive = platform === 'threads' ? state.threads : state.instagram;
    if (!alive) {
      // Сознательно НЕ логинимся сами — см. шапку файла.
      throw new Error(
        `нет живой сессии ${platform === 'threads' ? 'Threads' : 'Instagram'}. ` +
          'Зайди на VPS и выполни: cd dispatcher && npm run ig:login',
      );
    }

    const shoot = shooter(config.igShotsDir);
    const res =
      platform === 'threads'
        ? await postToThreads({ context: session.context, text, username: config.igLogin, shoot, log })
        : await postToInstagram({ context: session.context, files, caption, username: config.igLogin, shoot, log });

    return { ref: res.ref, dryRun: false, plan, note: res.note };
  } finally {
    await session.close();
  }
}
