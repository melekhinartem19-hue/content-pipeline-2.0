// Публикация в Instagram через веб-интерфейс живым браузером (вариант C).
//
// Отличие от API-пути (src/publish/instagram.js) в одном, но важном: здесь мы ЗАГРУЖАЕМ ФАЙЛ,
// а не даём Meta ссылку на скачивание. Поэтому браузерному пути НЕ НУЖНЫ PUBLIC_DIR и
// PUBLIC_BASE_URL — публичная статика с Nginx для публикации больше не требуется. Она остаётся
// нужной PDF-воронке (T13) и приёму роликов (T15), но не постам.
//
// ── Что делает мастер публикации ────────────────────────────────────────────────────────────
//   «Создать» → отдать файлы → [обрезка] → [фильтры/обложка] → подпись → «Поделиться»
//
// Число промежуточных шагов Instagram меняет: то добавит выбор обложки для видео, то уберёт
// фильтры. Поэтому мастер проходится ЦИКЛОМ «жми Next, пока не покажется поле подписи», а не
// фиксированными двумя кликами. Добавят шаг — код переживёт.
//
// ── Правило, которое нельзя нарушать ────────────────────────────────────────────────────────
// ПОСЛЕ УСПЕШНОГО «Поделиться» НИЧТО НЕ ИМЕЕТ ПРАВА БРОСИТЬ ИСКЛЮЧЕНИЕ. Пост уже в ленте;
// если мы упадём на попытке достать ссылку, очередь пометит элемент publish_failed, владелец
// нажмёт «Одобрить» повторно — и в аккаунте окажется ДВА одинаковых поста. Поэтому всё после
// подтверждения публикации завёрнуто в try/catch и может вернуть только пустую ссылку.

import { IG, IG_ORIGIN } from './selectors.js';

/** Лимит подписи — тот же, что у API: это ограничение Instagram, а не способа публикации. */
export const IG_CAPTION_LIMIT = 2200;

/** Сколько ждём загрузки файлов и готовности очередного шага мастера. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** Сколько ждём подтверждения «пост опубликован». Видео обрабатывается дольше картинок. */
const SHARE_TIMEOUT_MS = 300_000;

/** Потолок шагов мастера — защита от бесконечного цикла, если Next станет неубиваемым. */
const MAX_WIZARD_STEPS = 6;

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
 * Публикует пост в Instagram: карусель, одиночную картинку или Reels.
 *
 * @param {object} o
 * @param {object} o.context     залогиненный контекст браузера (см. session.js)
 * @param {string[]} o.files     ЛОКАЛЬНЫЕ пути к файлам (2–10 картинок, либо один файл)
 * @param {string} o.caption
 * @param {string} [o.username]  логин аккаунта — нужен, чтобы забрать ссылку на пост из профиля
 * @param {Function} [o.shoot]   снимок экрана при сбое: (page, name) => Promise<string|null>
 * @param {Function} [o.log]
 * @returns {Promise<{ref:string|null, note:string|null}>}
 */
export async function postToInstagram({ context, files, caption = '', username = null, shoot = null, log = () => {} }) {
  if (!files?.length) throw new Error('нет файлов для публикации');
  if (caption.length > IG_CAPTION_LIMIT) {
    throw new Error(`подпись ${caption.length} знаков, а Instagram принимает ${IG_CAPTION_LIMIT} — сократи`);
  }

  const page = await context.newPage();
  const snap = (name) => (shoot ? shoot(page, name) : Promise.resolve(null));

  try {
    await page.goto(IG_ORIGIN, { waitUntil: 'domcontentloaded', timeout: UPLOAD_TIMEOUT_MS });
    await clickIfPresent(page, IG.dismissDialog, 4_000);

    if (!(await clickIfPresent(page, IG.create, 15_000))) {
      throw new Error(`кнопка создания поста не найдена (скриншот: ${await snap('no-create')})`);
    }
    // Подменю «Post / Reel / Story» появляется не всегда — отсутствие не ошибка.
    await clickIfPresent(page, IG.createPost, 3_000);

    // Файл отдаём прямо в input: кнопка «Select from computer» открывает системный диалог,
    // которым из headless-браузера управлять нечем.
    const input = page.locator(IG.fileInput.join(', ')).first();
    await input.waitFor({ state: 'attached', timeout: 20_000 });
    await input.setInputFiles(files);
    log(`Instagram: отдано файлов — ${files.length}`);

    const captionField = await walkWizard(page, snap);
    if (caption) {
      // type(), а не fill(): поле contenteditable, и React-обработчики Instagram на программную
      // подстановку значения не реагируют — подпись молча осталась бы пустой.
      await captionField.click();
      await captionField.type(caption, { delay: 5 });
    }

    if (!(await clickIfPresent(page, IG.share, 10_000))) {
      throw new Error(`кнопка «Поделиться» не найдена (скриншот: ${await snap('no-share')})`);
    }

    const confirmed = await firstVisible(page, IG.shared, SHARE_TIMEOUT_MS);
    if (!confirmed) {
      // Здесь опасная зона: пост МОГ уйти, а подтверждение мы не увидели. Говорим об этом прямо,
      // чтобы владелец проверил ленту глазами, а не жал «Одобрить» повторно вслепую.
      throw new Error(
        'Instagram не подтвердил публикацию за отведённое время. ' +
          `ПРОВЕРЬ ЛЕНТУ ГЛАЗАМИ перед повторным одобрением — пост мог уйти (скриншот: ${await snap('no-confirm')})`,
      );
    }

    log('Instagram: пост опубликован');

    // ── Дальше падать нельзя: пост уже в ленте ──────────────────────────
    const ref = await grabPermalink(page, username).catch(() => null);
    return {
      ref,
      note: ref ? null : 'пост опубликован, но ссылку на него достать не удалось — в отчётах он будет без ссылки',
    };
  } finally {
    // Discard закрывает «точно выйти из редактора?», иначе окно повиснет и следующая
    // публикация откроется поверх недозакрытого мастера.
    await clickIfPresent(page, IG.discard, 2_000).catch(() => {});
    await page.close().catch(() => {});
  }
}

/**
 * Проходит промежуточные шаги мастера, пока не покажется поле подписи.
 * Именно цикл, а не «нажать Next дважды»: число шагов у Instagram плавает (обрезка, фильтры,
 * выбор обложки для видео), и жёсткая последовательность ломается на первом же изменении.
 */
async function walkWizard(page, snap) {
  for (let step = 0; step < MAX_WIZARD_STEPS; step += 1) {
    // Поле подписи — признак последнего шага. Проверяем ПЕРЕД кликом: если мастера
    // в этот раз не было вовсе, лишний Next увёл бы нас дальше подписи.
    const caption = await firstVisible(page, IG.caption, step === 0 ? 8_000 : 4_000);
    if (caption) return caption;

    if (!(await clickIfPresent(page, IG.next, 30_000))) break;
  }
  throw new Error(`не удалось дойти до поля подписи (скриншот: ${await snap('wizard-stuck')})`);
}

/**
 * Ссылка на только что опубликованный пост — первый пост в сетке СВОЕГО профиля.
 * Именно профиля, а не ленты: в ленте первым лежит чужой пост, и мы бы записали в отчёт
 * ссылку на публикацию постороннего аккаунта.
 *
 * Строго вспомогательная операция: её провал не должен влиять на факт публикации,
 * поэтому вызывающий код ловит исключение и просто остаётся без ссылки.
 */
async function grabPermalink(page, username) {
  if (!username) return null;
  await page.goto(`${IG_ORIGIN}/${encodeURIComponent(username)}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  const link = await firstVisible(page, IG.firstProfilePost, 8_000);
  if (!link) return null;
  const href = await link.getAttribute('href');
  return href ? new URL(href, IG_ORIGIN).toString() : null;
}
