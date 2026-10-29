// Смоук-тест заявок на монтаж (T16, автомонтаж). Оффлайн: база в памяти, Telegram не участвует.
// Запуск: node dispatcher/scripts/smoke-jobs.mjs
//
// Что проверяется: одобренный сценарий Reels рождает заявку (и ровно одну), ноут видит её списком
// и JSON-ом, залитый ролик её закрывает, отмена работает, а к готовому ролику заявка не плодится.

import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import {
  closeJobWithVideo,
  createJobFromItem,
  jobsAsJson,
  needsMontage,
  parseVideoCommand,
  renderJob,
  renderJobsList,
  renderNewJobNotice,
} from '../src/video/jobs.js';

// ── Кому нужен монтаж ─────────────────────────────────────────────────────
assert.equal(needsMontage({ kind: 'reels_script' }), true, 'сценарий Reels → монтаж');
assert.equal(needsMontage({ kind: 'reels_video' }), false, 'готовый ролик монтировать уже не надо');
assert.equal(needsMontage({ kind: 'tg_post' }), false, 'пост в TG к монтажу отношения не имеет');
assert.equal(needsMontage(null), false, 'пустой элемент не роняет проверку');

// ── Команды топика Видео ──────────────────────────────────────────────────
assert.deepEqual(parseVideoCommand('/видео'), { action: 'list' }, 'список заявок');
assert.deepEqual(parseVideoCommand('видео 7'), { action: 'show', id: 7 }, 'одна заявка');
assert.deepEqual(parseVideoCommand('/видео #7'), { action: 'show', id: 7 }, 'решётка тоже');
assert.deepEqual(parseVideoCommand('/видео отмена 7'), { action: 'cancel', id: 7 }, 'отмена заявки');
assert.deepEqual(parseVideoCommand('/video cancel 7'), { action: 'cancel', id: 7 }, 'латиница тоже');
assert.deepEqual(parseVideoCommand('/видео что там'), { action: 'help' }, 'непонятное → подсказка');
assert.equal(parseVideoCommand('видеомонтаж завтра'), null, 'похожее слово командой не считается');

// ── Заявка родилась из одобренного сценария ───────────────────────────────
const db = openDb(':memory:');
const scriptId = db.queue.add({
  platform: 'ig',
  agent: 'writer',
  kind: 'reels_script',
  title: 'Reels: ошибки на запуске',
  content: 'СЦЕНА 1. Крупный план…\nСЦЕНА 2. Титр «три ошибки»…',
  status: 'approved',
});
const item = db.queue.getById(scriptId);

const first = createJobFromItem({ db, item });
assert.equal(first.created, true, 'заявка создана');
const again = createJobFromItem({ db, item });
assert.equal(again.created, false, 'повторное «Одобрить» дубля не создаёт');
assert.equal(again.id, first.id, 'и возвращает ту же заявку');
assert.equal(db.videoJobs.list({ status: 'open' }).length, 1, 'в работе ровно одна заявка');

const job = db.videoJobs.getById(first.id);
assert.equal(job.title, 'Reels: ошибки на запуске', 'тема взята из черновика');
assert.match(job.script, /СЦЕНА 1/, 'сценарий уехал в заявку целиком — по нему монтируют');
assert.equal(job.queue_id, scriptId, 'видно, из какого черновика выросла заявка');

// ── Как это выглядит у человека и у ноутбука ──────────────────────────────
assert.match(renderNewJobNotice(job), /upload\.sh/, 'в уведомлении сказано, чем заливать');
assert.match(renderJobsList([job], db.videoJobs.countsByStatus()), /Ждут монтажа: 1/, 'список читается');
assert.match(renderJobsList([], {}), /Заявок на монтаж нет/, 'пустой список объясняет, откуда они берутся');
assert.match(renderJob(job), /СЦЕНА 2/, 'одна заявка показывается со сценарием');
assert.match(renderJob(null), /нет/, 'несуществующая заявка не роняет бота');

const parsed = JSON.parse(jobsAsJson([job]));
assert.equal(parsed.length, 1, 'JSON для ноутбука собран');
assert.deepEqual(Object.keys(parsed[0]).sort(), ['created_at', 'id', 'queue_id', 'script', 'title'], 'формат плоский и стабильный');

// ── Ролик приехал: заявка закрывается ─────────────────────────────────────
const videoId = db.queue.add({
  platform: 'ig',
  agent: 'video',
  kind: 'reels_video',
  title: 'Reels: ошибки на запуске',
  content: 'подпись',
  status: 'pending',
  meta: { video_url: 'https://media.example.com/video/reel.mp4' },
});
const closed = closeJobWithVideo({ db, jobId: first.id, resultQueueId: videoId });
assert.equal(closed.ok, true, 'заявка закрыта роликом');
assert.equal(db.videoJobs.getById(first.id).status, 'done', 'статус переехал в done');
assert.equal(db.videoJobs.getById(first.id).result_queue_id, videoId, 'видно, какой ролик её закрыл');
assert.equal(db.videoJobs.list({ status: 'open' }).length, 0, 'в работе больше ничего');

assert.equal(closeJobWithVideo({ db, jobId: first.id, resultQueueId: videoId }).ok, false, 'дважды не закрывается');
assert.match(closeJobWithVideo({ db, jobId: 999, resultQueueId: videoId }).error, /нет/, 'несуществующая заявка объясняется');

// ── Отмена ────────────────────────────────────────────────────────────────
const other = db.queue.add({ platform: 'ig', agent: 'writer', kind: 'reels_script', content: 'сценарий 2', status: 'approved' });
const second = createJobFromItem({ db, item: db.queue.getById(other) });
assert.equal(db.videoJobs.cancel(second.id, 'передумали'), true, 'заявку можно снять');
assert.equal(db.videoJobs.getById(second.id).status, 'cancelled', 'осталась в истории как отменённая');
assert.equal(db.videoJobs.cancel(second.id), false, 'снять дважды нельзя');

db.close();
console.log('✅ smoke-jobs: заявки на монтаж, их закрытие роликом и отмена — ок');
