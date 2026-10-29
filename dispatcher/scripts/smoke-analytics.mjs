// Смоук-тест отчётности Аналитика (T16). Оффлайн: база в памяти, агент и Graph API подставные.
// Запуск: node dispatcher/scripts/smoke-analytics.mjs
//
// Что проверяется: цифры считает КОД (а не агент), период учитывается, метрики площадок —
// необязательное дополнение и их отсутствие отчёт не роняет, автоотчёт не повторяется дважды
// за день и переживает перезапуск.

import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { platformForKind } from '../src/queue/kinds.js';
import {
  buildAnalystTask,
  collectFacts,
  parseReportCommand,
  renderFacts,
  renderMetrics,
  sinceStamp,
} from '../src/analytics/report.js';
import { collectInsights, insightsReady, parseInsights, renderInsightsNote } from '../src/analytics/insights.js';
import { LAST_RUN_KEY, renderReport, runReport, startAnalyticsScheduler } from '../src/analytics/run.js';

// ── Команда ───────────────────────────────────────────────────────────────
assert.deepEqual(parseReportCommand('/отчёт'), { days: 7 }, 'по умолчанию неделя');
assert.deepEqual(parseReportCommand('отчет'), { days: 7 }, 'без ё и без слэша тоже');
assert.deepEqual(parseReportCommand('/отчёт 30'), { days: 30 }, 'период числом');
assert.deepEqual(parseReportCommand('/отчёт месяц'), { days: 30 }, 'период словом');
assert.deepEqual(parseReportCommand('/report 400'), { days: 365 }, 'период ограничен годом');
assert.equal(parseReportCommand('отчётность по клиенту'), null, 'похожий текст командой не считается');

assert.equal(sinceStamp(7, new Date('2026-09-08T12:00:00Z')), '2026-09-01 12:00:00', 'граница периода в UTC, как в БД');

// ── Отчёт не публикуется ──────────────────────────────────────────────────
assert.equal(platformForKind('analytics_report'), null, 'отчёт Аналитика в очередь согласования не идёт');

// ── Факты считает код ─────────────────────────────────────────────────────
const db = openDb(':memory:');
const now = new Date();

const post = db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', title: 'Пост', content: 'текст', status: 'pending' });
db.queue.decide(post, 'approved', { by: '@owner' });
db.queue.markPublished(post, { messageId: 42, ref: '42' });

const reels = db.queue.add({ platform: 'ig', agent: 'video', kind: 'reels_video', title: 'Ролик', content: 'подпись', status: 'pending' });
db.queue.decide(reels, 'approved', { by: '@owner' });
db.queue.markPublished(reels, { ref: '17900000000000001' });

const rejected = db.queue.add({ platform: 'ig', agent: 'designer', kind: 'carousel_spec', content: 'слайды', status: 'pending' });
db.queue.decide(rejected, 'rejected', { by: '@owner' });

const edited = db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'версия 1', status: 'pending' });
db.queue.decide(edited, 'needs_edit', { by: '@owner', note: 'короче' });
db.queue.add({ platform: 'tg', agent: 'writer', kind: 'tg_post', content: 'версия 2', status: 'pending', parentId: edited });

db.metrics.add({ queueId: reels, platform: 'ig', ref: '17900000000000001', metrics: { views: 1200, likes: 80 } });

const facts = collectFacts({ db, days: 7, now });
assert.equal(facts.queue.decided.approved, 0, 'одобренное, но уже опубликованное считается опубликованным');
assert.equal(facts.published.length, 2, 'оба поста в периоде');
assert.equal(facts.queue.decided.rejected, 1, 'отклонённое посчитано');
assert.equal(facts.queue.decided.needs_edit, 1, 'на правке посчитано');
assert.equal(facts.queue.afterEdit, 1, 'версия после правки видна');
assert.equal(facts.queue.pendingNow, 1, 'ждёт решения новая версия');
assert.equal(facts.byPlatform.tg.count, 1, 'разбивка по площадкам');
assert.equal(facts.byPlatform.ig.kinds.reels_video, 1, 'и по видам контента');
assert.deepEqual(facts.published.find((p) => p.id === reels).metrics, { views: 1200, likes: 80 }, 'метрики подтянулись к посту');

const old = collectFacts({ db, days: 7, now: new Date(now.getTime() + 40 * 24 * 3600 * 1000) });
assert.equal(old.published.length, 0, 'за пределами периода публикаций нет — период реально работает');

const text = renderFacts(facts);
assert.match(text, /Опубликовано/, 'факты читаются человеком');
assert.match(text, /просмотры 1200/, 'метрики видны в отчёте');
assert.equal(renderMetrics({ views: 5, junk: 'нет' }), 'просмотры 5', 'нечисловое в метрики не лезет');

const task = buildAnalystTask(facts);
assert.match(task, /НЕ пересчитывай/, 'агенту прямо запрещено считать самому');
assert.match(task, /Что делать/, 'от агента ждут действий, а не пересказа');

// ── Метрики площадок: необязательное дополнение ───────────────────────────
assert.equal(insightsReady({}).ok, false, 'по умолчанию сбор метрик выключен');
assert.match(insightsReady({}).error, /ANALYTICS_INSIGHTS/, 'сказано, чем включается');
assert.match(insightsReady({ analyticsInsights: true }).error, /токена/, 'без токенов собирать нечем');

assert.deepEqual(
  parseInsights({ data: [{ name: 'reach', values: [{ value: 10 }] }, { name: 'likes', total_value: { value: 3 } }] }),
  { reach: 10, likes: 3 },
  'разбираются оба формата ответа Meta',
);

const igConfig = {
  analyticsInsights: true,
  igAccessToken: 'token',
  igGraphBaseUrl: 'https://graph.facebook.com',
  metaGraphVersion: 'v21.0',
};
const asked = [];
const fakeFetch = async (url) => {
  asked.push(String(url));
  return { ok: true, json: async () => ({ data: [{ name: 'views', values: [{ value: 999 }] }] }) };
};
const collected = await collectInsights({ db, posts: facts.published, config: igConfig, fetchImpl: fakeFetch });
assert.equal(collected.collected, 1, 'метрики спрошены только у Instagram');
assert.equal(collected.skipped, 1, 'у Telegram метрики не спрашиваются — Bot API их не отдаёт');
assert.match(asked[0], /17900000000000001\/insights/, 'спрашиваем именно про этот пост');
assert.match(asked[0], /metric=views/, 'у Reels спрашиваем просмотры');
assert.equal(db.metrics.latestFor(reels).metrics.views, 999, 'свежий снимок записан поверх старого');

const broken = await collectInsights({
  db,
  posts: facts.published,
  config: igConfig,
  fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'no permission', code: 10 } }) }),
});
assert.equal(broken.ok, true, 'отказ Meta не считается аварией сбора');
assert.equal(broken.collected, 0, 'но и метрик не появилось');
assert.match(renderInsightsNote(broken), /Не отдали метрики/, 'причина видна человеку');
assert.match(renderInsightsNote({ ok: false, error: 'выключено' }), /не собирались/, 'выключенный сбор объясняется');

// ── Отчёт целиком: агент вызывается ровно один раз ────────────────────────
let runs = 0;
const runner = async ({ agentKey, task }) => {
  runs += 1;
  assert.equal(agentKey, 'analyst', 'зовём Аналитика');
  assert.match(task, /ФАКТЫ/, 'агенту отданы посчитанные факты');
  return { ok: true, content: 'Выводы: всё ровно.', meta: { kind: 'analytics_report' } };
};

const report = await runReport({ db, config: { analyticsInsights: false }, days: 7, now, runner });
assert.equal(runs, 1, 'ровно один вызов claude -p на отчёт');
assert.match(renderReport(report), /Выводы Аналитика/, 'в отчёте есть и факты, и выводы');

const failed = await runReport({
  db,
  config: {},
  days: 7,
  now,
  runner: async () => ({ ok: false, error: 'agents/analyst.md не найден' }),
});
assert.match(renderReport(failed), /Факты за 7/, 'факты доходят до владельца даже без агента');
assert.match(renderReport(failed), /Выводы не собраны/, 'и честно сказано, почему нет выводов');

// ── Автоотчёт: раз в неделю, не дважды за день, переживает перезапуск ─────
let scheduled = 0;
let clockNow = new Date(2026, 8, 7, 10, 30); // понедельник, 10:30
assert.equal(clockNow.getDay(), 1, 'проверочная дата действительно понедельник');

const stop = startAnalyticsScheduler({
  db,
  config: { analyticsAt: '10:00', analyticsWeekday: 1, analyticsDays: 7 },
  intervalMs: 60_000, // сам таймер не ждём: тик дёргаем явно, чтобы тест был быстрым и честным
  clock: () => clockNow,
  runner: async () => {
    scheduled += 1;
    return { ok: true, content: 'выводы' };
  },
});

await stop.tick();
assert.equal(scheduled, 1, 'в понедельник после 10:00 отчёт собрался');
assert.equal(db.state.get(LAST_RUN_KEY), '2026-09-07', 'отметка легла в БД, а не в память процесса');

await stop.tick();
assert.equal(scheduled, 1, 'второй тик в тот же день отчёт не повторяет');

clockNow = new Date(2026, 8, 8, 10, 30); // вторник
await stop.tick();
assert.equal(scheduled, 1, 'не в свой день недели отчёт не собирается');

clockNow = new Date(2026, 8, 14, 9, 30); // понедельник, но до времени отчёта
await stop.tick();
assert.equal(scheduled, 1, 'до назначенного часа отчёт ждёт');

clockNow = new Date(2026, 8, 14, 10, 5); // следующий понедельник, время пришло
await stop.tick();
assert.equal(scheduled, 2, 'через неделю отчёт собрался снова');
stop();

// Перезапуск процесса: новый планировщик на той же базе повторно не стреляет.
let afterRestart = 0;
const restarted = startAnalyticsScheduler({
  db,
  config: { analyticsAt: '10:00', analyticsWeekday: 1, analyticsDays: 7 },
  intervalMs: 60_000,
  clock: () => clockNow,
  runner: async () => {
    afterRestart += 1;
    return { ok: true, content: 'выводы' };
  },
});
await restarted.tick();
assert.equal(afterRestart, 0, 'после перезапуска отчёт за тот же день не дублируется');
restarted();

const off = startAnalyticsScheduler({ db, config: {}, intervalMs: 60_000, clock: () => clockNow, runner: async () => { throw new Error('не должно вызваться'); } });
await off.tick();
off(); // без ANALYTICS_AT автоотчёта нет вовсе — работает только «/отчёт» руками

db.close();
console.log('✅ smoke-analytics: факты, метрики, отчёт и его расписание — ок');
