// Отчётность Аналитика (T16): факты из собственной базы → выводы агента.
//
// РАЗДЕЛЕНИЕ ТРУДА. Цифры считает КОД: сколько черновиков прошло, что одобрили с первого раза, что
// ушло на правку, что опубликовалось и куда. Агент их не считает — он их ЧИТАЕТ и говорит, что с
// этим делать. Так дешевле (один вызов `claude -p` на отчёт вместо разбора базы вслух) и, главное,
// честнее: цифру нельзя выдумать, если она пришла готовой.
//
// ПОЧЕМУ ОТЧЁТ ЖИВЁТ НА СВОЕЙ БАЗЕ, А НЕ НА МЕТРИКАХ META. Метрики площадок — приятное дополнение
// (insights.js), но они требуют отдельных прав в Meta, а App Review мы не проходим (правило 2).
// Поэтому основа отчёта — то, что диспетчер знает и так: сколько сделано, что застряло, где рвётся
// конвейер. Это работает у любого клиента с первого дня, без единой настройки.
//
// В ОЧЕРЕДЬ СОГЛАСОВАНИЯ ОТЧЁТ НЕ ИДЁТ: `analytics_report` нет в kinds.js — это внутренняя
// аналитика для владельца, а не публикуемый контент.

/** Разбирает «/отчёт», «/отчёт 30», «/отчёт месяц». Возвращает { days } или null. */
export function parseReportCommand(text) {
  const t = String(text || '').trim();
  if (!/^\/?(отчёт|отчет|report)(?![\p{L}\p{N}_])/iu.test(t)) return null;

  const rest = t.replace(/^\/?(отчёт|отчет|report)/iu, '').trim().toLowerCase();
  if (!rest) return { days: 7 };
  if (/^(неделя|week)$/u.test(rest)) return { days: 7 };
  if (/^(месяц|month)$/u.test(rest)) return { days: 30 };

  const n = /^(\d{1,3})/.exec(rest);
  // Потолок — год: отчёт «за всё время» на растущей базе превращается в простыню.
  return { days: n ? Math.min(365, Math.max(1, Number(n[1]))) : 7 };
}

/**
 * Начало периода в том же виде, в каком SQLite пишет datetime('now') — UTC, `YYYY-MM-DD HH:MM:SS`.
 * Локальное время тут использовать нельзя: строки в базе сравниваются лексикографически.
 */
export function sinceStamp(days, now = new Date()) {
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Собирает факты за период. Чистая работа с БД — ни Telegram, ни агента, ни сети.
 * @returns {object} факты, пригодные и для показа человеку, и для промпта агенту
 */
export function collectFacts({ db, days = 7, now = new Date() }) {
  const since = sinceStamp(days, now);
  const moved = db.queue.listSince(since, { limit: 1000 });

  const decided = { approved: 0, rejected: 0, needs_edit: 0 };
  const published = [];
  let publishFailed = 0;
  let afterEdit = 0;

  for (const it of moved) {
    if (it.status in decided) decided[it.status] += 1;
    if (it.status === 'publish_failed') publishFailed += 1;
    if (it.status === 'published' && it.published_at >= since) published.push(it);
    if (it.parent_id) afterEdit += 1;
  }

  const created = moved.filter((it) => it.created_at >= since).length;
  const byPlatform = {};
  for (const it of published) {
    const p = (byPlatform[it.platform] ||= { count: 0, kinds: {} });
    p.count += 1;
    p.kinds[it.kind] = (p.kinds[it.kind] || 0) + 1;
  }

  const metrics = db.metrics.latestByQueue(published.map((it) => it.id));
  const decidedTotal = decided.approved + decided.rejected + decided.needs_edit;

  return {
    days,
    since,
    generatedAt: now.toISOString().slice(0, 19).replace('T', ' '),
    queue: {
      created,
      decided,
      decidedTotal,
      // Доля одобренного среди решённого: главный индикатор «попадает ли конвейер в бренд».
      approveRate: decidedTotal ? Math.round((decided.approved / decidedTotal) * 100) : null,
      afterEdit,
      publishFailed,
      pendingNow: db.queue.listPending({ limit: 100 }).length,
      totals: db.queue.countsByStatus(),
    },
    published: published.map((it) => ({
      id: it.id,
      platform: it.platform,
      kind: it.kind,
      title: it.title || firstLine(it.content),
      publishedAt: it.published_at,
      ref: it.published_ref,
      metrics: metrics[it.id] || null,
    })),
    byPlatform,
    tasks: db.tasks.countsByStatus(),
    trends: {
      runs: db.trends.listRuns({ limit: 10 }).filter((r) => r.started_at >= since),
      topicsUnused: db.trends.listTopics({ limit: 50, unusedOnly: true }).length,
    },
    funnel: db.funnel.list().map((f) => ({ key: f.key, title: f.title, url: f.url, syncedUrl: f.manychat_url })),
    video: {
      counts: db.videoJobs.countsByStatus(),
      open: db.videoJobs.list({ status: 'open', limit: 20 }).length,
    },
  };
}

/** Факты словами: это уходит в топик Аналитика ДО выводов агента и в промпт агенту. */
export function renderFacts(facts) {
  const q = facts.queue;
  const lines = [
    `📊 Факты за ${facts.days} дн. (с ${facts.since} UTC)`,
    '',
    '── Конвейер ──',
    `Черновиков создано: ${q.created} · решено: ${q.decidedTotal} ` +
      `(одобрено ${q.decided.approved} · отклонено ${q.decided.rejected} · на правку ${q.decided.needs_edit})`,
    q.approveRate === null ? 'Доля одобренного: нет решений за период' : `Доля одобренного: ${q.approveRate}%`,
    `Версий после правки: ${q.afterEdit} · ждут решения сейчас: ${q.pendingNow}` +
      (q.publishFailed ? ` · сорвалось публикаций: ${q.publishFailed}` : ''),
  ];

  lines.push('', '── Опубликовано ──');
  if (!facts.published.length) {
    lines.push('За период не опубликовано ничего.');
  } else {
    for (const [platform, p] of Object.entries(facts.byPlatform)) {
      const kinds = Object.entries(p.kinds).map(([k, n]) => `${k}: ${n}`).join(', ');
      lines.push(`${PLATFORM_TITLE[platform] || platform}: ${p.count} (${kinds})`);
    }
    lines.push('');
    for (const post of facts.published.slice(0, 15)) {
      const m = post.metrics ? ` · ${renderMetrics(post.metrics)}` : '';
      lines.push(`#${post.id} ${PLATFORM_TITLE[post.platform] || post.platform} · ${post.title}${m}`);
    }
  }

  const t = facts.tasks;
  lines.push(
    '',
    '── Прочее ──',
    `Задачи Продюсера: ${Object.entries(t).map(([k, n]) => `${k}: ${n}`).join(' · ') || 'нет'}`,
    `Сборы трендов за период: ${facts.trends.runs.length} · неиспользованных тем: ${facts.trends.topicsUnused}`,
    `Заявки на монтаж: ждут ${facts.video.open} · всего ${
      Object.entries(facts.video.counts).map(([k, n]) => `${k}: ${n}`).join(' · ') || 'нет'
    }`,
    `PDF воронки: ${facts.funnel.length} тем${facts.funnel.some((f) => !f.url) ? ' (у части нет публичной ссылки)' : ''}`,
  );

  return lines.join('\n');
}

/**
 * Промпт Аналитику: факты + чего от него хотят. Сами цифры уже посчитаны — агенту остаётся
 * объяснить их и предложить, что менять. Просить его «посчитать» нельзя: он ошибётся, а проверить
 * будет нечем.
 */
export function buildAnalystTask(facts) {
  return [
    `Разбери работу контент-конвейера за ${facts.days} дней и дай выводы владельцу.`,
    '',
    'Цифры ниже посчитаны диспетчером и верны — НЕ пересчитывай их и не выдумывай новых.',
    'Твоя работа: объяснить, что эти цифры значат, и предложить конкретные шаги.',
    '',
    'Нужны три части:',
    '1. Что происходит — 3–5 наблюдений по фактам (без воды).',
    '2. Где узкое место — что тормозит или рвётся в конвейере и почему.',
    '3. Что делать — 2–4 конкретных действия на ближайшую неделю.',
    '',
    'Если данных мало (мало решений, ничего не опубликовано) — так и скажи, а не додумывай выводы.',
    '',
    '════ ФАКТЫ ════',
    renderFacts(facts),
    '',
    '════ СЫРЫЕ ДАННЫЕ (JSON, если нужны детали) ════',
    JSON.stringify(
      { queue: facts.queue, byPlatform: facts.byPlatform, published: facts.published, video: facts.video },
      null,
      1,
    ),
  ].join('\n');
}

const PLATFORM_TITLE = { tg: 'Telegram', ig: 'Instagram', threads: 'Threads' };

/** Метрики поста короткой строкой: набор полей у площадок разный, поэтому печатаем что есть. */
export function renderMetrics(metrics) {
  const names = { views: 'просмотры', reach: 'охват', likes: 'лайки', comments: 'комменты', saved: 'сохранения', shares: 'репосты', replies: 'ответы', reposts: 'репосты' };
  return Object.entries(metrics)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${names[k] || k} ${v}`)
    .join(', ');
}

function firstLine(text, max = 60) {
  const line = String(text || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
