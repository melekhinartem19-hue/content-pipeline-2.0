// Публикация в Threads через веб-интерфейс живым браузером (вариант C).
//
// Threads устроен проще Instagram: никакого мастера с шагами — открыть окно, вписать текст,
// нажать «Post». Поэтому и кода здесь меньше.
//
// Публикуем ТОЛЬКО ТЕКСТ — ровно как на API-пути (src/publish/threads.js). Картинки Threads
// умеет, но это отдельный формат и отдельное согласование (правило 6 в CLAUDE.md): молча
// превращать одобренный текстовый пост в медийный нельзя.
//
// Правило «после публикации не падать» здесь то же, что у Instagram: пост уже в ленте, и
// исключение на попытке достать ссылку обернулось бы повторной публикацией того же текста.

import { THREADS, THREADS_ORIGIN } from './selectors.js';

/** Лимит поста — ограничение площадки, а не способа публикации. Тот же, что у API-пути. */
export const THREADS_TEXT_LIMIT = 500;

const POST_TIMEOUT_MS = 90_000;

async function firstVisible(page, selectors, timeout = 3_000) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch {
      // нет такого варианта — следующий
    }
  }
  return null;
}

async function clickIfPresent(page, selectors, timeout = 3_000) {
  const loc = await firstVisible(page, selectors, timeout);
  if (!loc) return false;
  await loc.click().catch(() => {});
  return true;
}

/**
 * Публикует текстовый пост в Threads.
 *
 * @param {object} o
 * @param {object} o.context     залогиненный контекст браузера (см. session.js)
 * @param {string} o.text        одобренный текст (item.content)
 * @param {string} [o.username]  логин — нужен, чтобы забрать ссылку на пост из профиля
 * @param {Function} [o.shoot]
 * @param {Function} [o.log]
 * @returns {Promise<{ref:string|null, note:string|null}>}
 */
export async function postToThreads({ context, text, username = null, shoot = null, log = () => {} }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('пустой текст — публиковать нечего');
  if (body.length > THREADS_TEXT_LIMIT) {
    throw new Error(
      `текст ${body.length} знаков, а Threads принимает не больше ${THREADS_TEXT_LIMIT} — ` +
        'сократи через «Правка» и одобри заново',
    );
  }

  const page = await context.newPage();
  const snap = (name) => (shoot ? shoot(page, name) : Promise.resolve(null));

  try {
    await page.goto(THREADS_ORIGIN, { waitUntil: 'domcontentloaded', timeout: POST_TIMEOUT_MS });

    if (!(await clickIfPresent(page, THREADS.openComposer, 15_000))) {
      throw new Error(`не открылось окно нового поста (скриншот: ${await snap('threads-no-composer')})`);
    }

    const field = await firstVisible(page, THREADS.input, 10_000);
    if (!field) throw new Error(`поле ввода не найдено (скриншот: ${await snap('threads-no-input')})`);

    // type(), а не fill(): поле contenteditable, и на программную подстановку значения
    // обработчики Threads не реагируют — кнопка «Post» осталась бы неактивной.
    await field.click();
    await field.type(body, { delay: 5 });

    if (!(await clickIfPresent(page, THREADS.post, 10_000))) {
      throw new Error(`кнопка «Post» не найдена (скриншот: ${await snap('threads-no-post')})`);
    }

    // Подтверждение — исчезновение окна ввода. Отдельного «опубликовано» Threads не показывает.
    const gone = await field
      .waitFor({ state: 'detached', timeout: POST_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    if (!gone) {
      throw new Error(
        'Threads не закрыл окно ввода — публикация не подтвердилась. ' +
          `ПРОВЕРЬ ЛЕНТУ ГЛАЗАМИ перед повторным одобрением (скриншот: ${await snap('threads-stuck')})`,
      );
    }

    log('Threads: пост опубликован');

    // ── Дальше падать нельзя: пост уже в ленте ──────────────────────────
    const ref = await grabPermalink(page, username).catch(() => null);
    return {
      ref,
      note: ref ? null : 'пост опубликован, но ссылку на него достать не удалось — в отчётах он будет без ссылки',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Ссылка на свежий пост — первая в СВОЁМ профиле. Вспомогательно: провал ни на что не влияет. */
async function grabPermalink(page, username) {
  if (!username) return null;
  await page.goto(`${THREADS_ORIGIN}/@${encodeURIComponent(username)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  const link = await firstVisible(page, THREADS.firstProfilePost, 8_000);
  if (!link) return null;
  const href = await link.getAttribute('href');
  return href ? new URL(href, THREADS_ORIGIN).toString() : null;
}
