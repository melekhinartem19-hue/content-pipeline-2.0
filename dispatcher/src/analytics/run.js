// Прогон отчёта Аналитика: факты → (необязательно) метрики площадок → выводы агента (T16).
//
// ПОРЯДОК ВАЖЕН. Сначала цифры, потом мнение: агенту нельзя давать считать, ему можно давать
// объяснять. Поэтому сюда он попадает последним и получает уже посчитанные факты (report.js).
//
// ОДИН ВЫЗОВ `claude -p` НА ОТЧЁТ. Аналитика не должна становиться самой дорогой частью системы:
// факты собираются кодом, агент вызывается ровно один раз. Автоотчёт по умолчанию выключен и
// включается ANALYTICS_AT — раз в неделю, а не ежедневно.
//
// ОТЧЁТ НЕ ИДЁТ В ОЧЕРЕДЬ СОГЛАСОВАНИЯ. Он не публикуется, он для владельца (см. kinds.js).

import { runAgent } from '../agent.js';
import { collectFacts, buildAnalystTask, renderFacts } from './report.js';
import { collectInsights, renderInsightsNote } from './insights.js';

/** Ключ агента-Аналитика (agents/analyst.md). */
export const ANALYST_AGENT = 'analyst';

/** Отметка последнего автоотчёта: живёт в БД, чтобы перезапуск не прислал отчёт второй раз. */
export const LAST_RUN_KEY = 'analytics_last_report_day';

/**
 * Собирает отчёт за период.
 * @returns {Promise<{ok:boolean, facts:object, factsText:string, insightsNote:string|null,
 *   analysis:string|null, error:string|null}>}
 */
export async function runReport({
  db,
  config,
  days = 7,
  now = new Date(),
  runner = runAgent,
  fetchImpl = globalThis.fetch,
  onLog = null,
}) {
  let facts = collectFacts({ db, days, now });

  // Метрики площадок — необязательный шаг. Их отсутствие не должно мешать отчёту: без прав в Meta
  // (а App Review мы не проходим) отчёт просто выйдет по фактам собственной базы.
  let insightsNote = null;
  if (config?.analyticsInsights) {
    const res = await collectInsights({ db, posts: facts.published, config, fetchImpl, onLog });
    insightsNote = renderInsightsNote(res);
    // Собранные снимки должны попасть в отчёт — пересобираем факты уже с ними.
    if (res.ok && res.collected) facts = collectFacts({ db, days, now });
  }

  const factsText = renderFacts(facts);
  const res = await runner({ agentKey: ANALYST_AGENT, task: buildAnalystTask(facts) });

  return {
    ok: res.ok,
    facts,
    factsText,
    insightsNote,
    analysis: res.ok ? res.content : null,
    // Частая причина на свежей установке: agents/analyst.md ещё не лежит на месте.
    error: res.ok ? null : res.error || 'агент не вернул результат',
  };
}

/** Что уходит в топик Аналитика: факты, заметка о метриках и выводы агента. */
export function renderReport(res) {
  const parts = [res.factsText];
  if (res.insightsNote) parts.push(res.insightsNote);
  parts.push(res.ok ? `\n🧠 Выводы Аналитика\n\n${res.analysis}` : `\n⚠️ Выводы не собраны: ${res.error}`);
  return parts.join('\n');
}

/**
 * Еженедельный автоотчёт. Ровно как у трендов: тик раз в N минут, а не «спать до пятницы» —
 * так расписание переживает перезапуск процесса и перевод часов.
 *
 * @param {object} o
 * @param {Function} [o.onReport]  куда отдать готовый отчёт (обычно — сообщение в топик Аналитика)
 * @returns {Function} остановка планировщика
 */
export function startAnalyticsScheduler({
  db,
  config,
  intervalMs = 15 * 60_000,
  onReport = null,
  onLog = null,
  clock = () => new Date(), // инъекция для тестов: расписание должно проверяться без ожидания недели
  ...deps
}) {
  const tick = async () => {
    if (!config.analyticsAt) return; // автоотчёт не настроен — работает только «/отчёт» руками
    const now = clock();
    if (now.getDay() !== config.analyticsWeekday) return;
    if (hhmm(now) < String(config.analyticsAt)) return;

    const today = ymd(now);
    if (db.state.get(LAST_RUN_KEY) === today) return;
    // Отметку ставим ДО прогона: отчёт идёт минуту-две, и следующий тик не должен запустить второй.
    db.state.set(LAST_RUN_KEY, today);

    const res = await runReport({ db, config, days: config.analyticsDays, now, onLog, ...deps });
    if (onReport) await onReport(res);
  };

  const timer = setInterval(() => {
    tick().catch((err) => console.error('[analytics] tick error:', err));
  }, intervalMs);
  timer.unref?.(); // отчётность не должна сама по себе держать процесс живым

  const stop = () => clearInterval(timer);
  stop.tick = tick; // тот же тик, что и по таймеру: тест проверяет реальное правило, а не копию
  return stop;
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
