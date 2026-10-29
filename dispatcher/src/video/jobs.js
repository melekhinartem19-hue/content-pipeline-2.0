// Заявки на монтаж: мост между одобренным сценарием на VPS и ноутбуком клиента (T16, автомонтаж).
//
// ЧТО ЗДЕСЬ АВТОМАТИЗИРУЕТСЯ. Раньше цепочка обрывалась: Сценарист писал сценарий Reels, владелец
// его одобрял — и на этом всё, потому что публиковать нечего (ролика нет), а монтаж живёт на
// другой машине. Теперь одобрение сценария САМО создаёт заявку на монтаж и говорит об этом в
// топике Видео. Человеку остаётся сесть за ноут и запустить монтаж — искать «что монтировать»
// и переносить сценарий руками больше не нужно.
//
// ЧЕГО ЗДЕСЬ НЕТ. «Автомонтаж» не означает «без человека»: сборка идёт из реальных клипов, их
// выбирает человек. Автоматика доводит задачу до ноутбука и закрывает круг обратно.
//
// PULL, А НЕ PUSH. VPS не стучится на ноут: портов наружу нет, а ноут включён не всегда. Заявка
// ждёт в БД, пока ноутбук сам не спросит (`video/pull-jobs.sh` → `npm run video:jobs`).

/** Вид контента, из которого рождается заявка: сценарий Reels от Сценариста. */
export const SCRIPT_KIND = 'reels_script';

/** Стоит ли по этому элементу очереди заводить монтаж. */
export function needsMontage(item) {
  return item?.kind === SCRIPT_KIND;
}

/**
 * Заводит заявку на монтаж по одобренному сценарию. Повторное «Одобрить» дубля не создаёт —
 * за этим следит уникальный индекс миграции 009.
 * @returns {{id:number, created:boolean}}
 */
export function createJobFromItem({ db, item }) {
  return db.videoJobs.add({
    queueId: item.id,
    title: item.title || firstLine(item.content),
    script: item.content,
  });
}

/**
 * Закрывает заявку приехавшим роликом: `resultQueueId` — карточка этого ролика в очереди.
 * @returns {{ok:boolean, error?:string}}
 */
export function closeJobWithVideo({ db, jobId, resultQueueId }) {
  const job = db.videoJobs.getById(jobId);
  if (!job) return { ok: false, error: `заявки #${jobId} нет` };
  if (job.status === 'done') return { ok: false, error: `заявка #${jobId} уже закрыта` };
  db.videoJobs.markDone(jobId, { resultQueueId, note: `смонтировано, карточка #${resultQueueId}` });
  return { ok: true };
}

/** Разбирает «/видео», «/видео 3», «/видео отмена 3». */
export function parseVideoCommand(text) {
  const t = String(text || '').trim();
  if (!/^\/?(видео|video)(?![\p{L}\p{N}_])/iu.test(t)) return null;

  const rest = t.replace(/^\/?(видео|video)/iu, '').trim();
  if (!rest) return { action: 'list' };

  const cancel = /^(отмена|отменить|cancel)\s+#?(\d+)$/iu.exec(rest);
  if (cancel) return { action: 'cancel', id: Number(cancel[2]) };

  const one = /^#?(\d+)$/.exec(rest);
  if (one) return { action: 'show', id: Number(one[1]) };

  return { action: 'help' };
}

/** Список заявок для топика Видео. */
export function renderJobsList(jobs, counts = {}) {
  if (!jobs.length) {
    return [
      '🎬 Заявок на монтаж нет.',
      '',
      'Заявка появляется сама, когда владелец одобряет сценарий Reels в топике Издателя.',
      `Всего за всё время: ${renderCounts(counts)}`,
    ].join('\n');
  }
  const lines = [`🎬 Ждут монтажа: ${jobs.length}. Всего: ${renderCounts(counts)}`, ''];
  for (const job of jobs) {
    lines.push(`#${job.id} · ${job.title || firstLine(job.script)} (сценарий #${job.queue_id ?? '—'})`);
  }
  lines.push('', 'На ноуте: ./video/pull-jobs.sh → смонтировать → ./video/upload.sh <файл> --job <N>');
  return lines.join('\n');
}

/** Одна заявка целиком: сценарий нужен целиком, по нему монтируют. */
export function renderJob(job) {
  if (!job) return '⚠️ Заявки с таким номером нет.';
  const status = { open: '⏳ ждёт монтажа', done: '✅ смонтировано', cancelled: '🚫 отменена' }[job.status] || job.status;
  return [
    `🎬 Заявка #${job.id} · ${status}`,
    job.title ? `Тема: ${job.title}` : null,
    job.result_queue_id ? `Готовый ролик: черновик #${job.result_queue_id}` : null,
    job.note ? `Заметка: ${job.note}` : null,
    '',
    job.script,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Сообщение в топик Видео о новой заявке. */
export function renderNewJobNotice(job) {
  return [
    `🎬 Новая заявка на монтаж #${job.id}`,
    job.title ? `Тема: ${job.title}` : null,
    '',
    'Сценарий одобрен владельцем. Дальше — ноутбук:',
    '  ./video/pull-jobs.sh            — забрать заявки',
    `  ./video/upload.sh <файл.mp4> --job ${job.id}  — залить готовый ролик`,
    '',
    'Ролик приедет карточкой в топик Издателя — публикация после «Одобрить».',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Заявки в JSON — это читает локальный Claude Code на ноуте.
 * Формат нарочно плоский и стабильный: скрипт на ноуте не должен знать про устройство БД.
 */
export function jobsAsJson(jobs) {
  return JSON.stringify(
    jobs.map((j) => ({
      id: j.id,
      title: j.title,
      script: j.script,
      queue_id: j.queue_id,
      created_at: j.created_at,
    })),
    null,
    2,
  );
}

function renderCounts(counts) {
  const map = { open: 'ждут', done: 'смонтировано', cancelled: 'отменено' };
  const parts = Object.entries(counts).map(([k, n]) => `${map[k] || k}: ${n}`);
  return parts.length ? parts.join(' · ') : 'пусто';
}

function firstLine(text, max = 60) {
  const line = String(text || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
