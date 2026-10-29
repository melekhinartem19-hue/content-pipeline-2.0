// Публикация в Telegram-канал клиента (T08) — низкий уровень: только отправка.
//
// Публикует БОТ ИЗДАТЕЛЯ, поэтому он должен быть админом канала с правом постить. Это Bot API,
// никакого Meta App Review здесь нет (см. CLAUDE.md, правило 2 — оно про IG/Threads, T11/T12).
//
// Фото: путь или URL кладётся агентом в META (`photo` / `photo_url` / `image`). Своих картинок
// диспетчер не рисует — рендер это T10; здесь только отправка того, что дали.

import { InputFile } from 'grammy';
import { splitForTelegram } from '../bots/send.js';

/** Лимит подписи к фото в Telegram — вчетверо меньше лимита обычного сообщения. */
export const CAPTION_LIMIT = 1024;

/** Достаёт картинку из META агента. Ничего не найдено → текстовый пост. */
export function pickPhoto(meta) {
  for (const key of ['photo', 'photo_url', 'photoUrl', 'image']) {
    const v = meta?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** URL отдаём Telegram строкой, локальный файл — через InputFile (его читает grammY). */
function toPhotoInput(photo) {
  return /^https?:\/\//i.test(photo) ? photo : new InputFile(photo);
}

/**
 * Отправляет пост в канал. Текст длиннее лимита режется на части.
 * @param {object} o
 * @param {object} o.bot  бот Издателя (должен быть админом канала)
 * @param {number|string} o.channelId  id канала (@username тоже подойдёт)
 * @param {string} o.text  текст поста
 * @param {string|null} [o.photo]  путь или URL картинки
 * @returns {Promise<{messageId:number}>}  id первого сообщения поста
 */
export async function publishToTelegram({ bot, channelId, text, photo = null }) {
  const parts = splitForTelegram(text);

  if (!photo) {
    let first = null;
    for (const part of parts) {
      const msg = await bot.api.sendMessage(channelId, part);
      first ??= msg.message_id;
    }
    return { messageId: first };
  }

  // Короткий текст влезает подписью к фото — это один пост, а не «картинка + простыня».
  if (text.length <= CAPTION_LIMIT) {
    const msg = await bot.api.sendPhoto(channelId, toPhotoInput(photo), { caption: text });
    return { messageId: msg.message_id };
  }

  const photoMsg = await bot.api.sendPhoto(channelId, toPhotoInput(photo));
  for (const part of parts) {
    await bot.api.sendMessage(channelId, part);
  }
  return { messageId: photoMsg.message_id };
}
