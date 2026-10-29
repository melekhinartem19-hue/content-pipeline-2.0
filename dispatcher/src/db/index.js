// Слой доступа к данным. ЕДИНСТВЕННОЕ место, где живёт конкретная СУБД (node:sqlite).
//
// Правило: вызывающий код НЕ пишет сырой SQL и НЕ импортирует node:sqlite напрямую — он зовёт
// методы репозиториев (db.queue.add(...), db.queue.getById(...) и т.д.). Это и есть абстракция
// под будущий Postgres: чтобы переехать, переписываем ТОЛЬКО этот файл + migrate.js + диалект в
// миграциях (см. specs/db.md, раздел «Переезд на Postgres»). Вызывающие остаются нетронутыми.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.js';
import { config } from '../config.js';

/**
 * Открывает БД по пути, применяет миграции, возвращает фасад с репозиториями.
 * @param {string} [dbPath] путь к SQLite-файлу (default: config.dbPath). ':memory:' — для тестов.
 */
export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');

  const appliedNow = migrate(raw);

  return new DbFacade(raw, appliedNow);
}

class DbFacade {
  #raw;
  constructor(raw, appliedMigrations = []) {
    this.#raw = raw;
    this.appliedMigrations = appliedMigrations;
    this.queue = new QueueRepo(raw);
    this.tasks = new TasksRepo(raw);
    this.trends = new TrendsRepo(raw);
    this.funnel = new FunnelRepo(raw);
    this.videoJobs = new VideoJobsRepo(raw);
    this.metrics = new MetricsRepo(raw);
    this.state = new StateRepo(raw);
  }
  close() {
    this.#raw.close();
  }
}

/** Репозиторий очереди согласования (T07): черновики, карточки с кнопками, версии правок. */
class QueueRepo {
  #raw;
  constructor(raw) {
    this.#raw = raw;
  }

  /**
   * Добавить черновик в очередь. meta — произвольный объект (хранится JSON-строкой). Возвращает id.
   * taskId — откуда черновик (tasks.id из T05); parentId — версия, которую он заменяет после правки.
   */
  add({
    platform,
    agent,
    kind,
    title = null,
    content,
    status = 'draft',
    meta = null,
    taskId = null,
    parentId = null,
    editNote = null,
  }) {
    const info = this.#raw
      .prepare(
        `INSERT INTO approval_queue (platform, agent, kind, title, content, status, meta, task_id, parent_id, edit_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(platform, agent, kind, title, content, status, meta ? JSON.stringify(meta) : null, taskId, parentId, editNote);
    return Number(info.lastInsertRowid);
  }

  /** Одна запись по id (или undefined). meta разворачивается обратно в объект. */
  getById(id) {
    const row = this.#raw.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id);
    return row ? hydrate(row) : undefined;
  }

  /** Список записей, опционально по статусу, новые сверху. */
  list({ status = null, limit = 50 } = {}) {
    const rows = status
      ? this.#raw
          .prepare('SELECT * FROM approval_queue WHERE status = ? ORDER BY id DESC LIMIT ?')
          .all(status, limit)
      : this.#raw
          .prepare('SELECT * FROM approval_queue ORDER BY id DESC LIMIT ?')
          .all(limit);
    return rows.map(hydrate);
  }

  /** Сменить статус записи (approved/rejected/published/…). Возвращает true, если строка была. */
  setStatus(id, status) {
    const info = this.#raw
      .prepare(`UPDATE approval_queue SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
    return info.changes > 0;
  }

  /**
   * Запомнить, где висит карточка с кнопками. Без этого после перезапуска процесса нечего
   * редактировать: связь «сообщение в Telegram ↔ элемент очереди» живёт только в БД.
   */
  attachCard(id, { chatId, messageId }) {
    const info = this.#raw
      .prepare(
        `UPDATE approval_queue SET card_chat_id = ?, card_message_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(String(chatId), Number(messageId), id);
    return info.changes > 0;
  }

  /** Найти элемент очереди по сообщению-карточке (нажали кнопку / ответили правкой). */
  getByCard(chatId, messageId) {
    const row = this.#raw
      .prepare('SELECT * FROM approval_queue WHERE card_chat_id = ? AND card_message_id = ?')
      .get(String(chatId), Number(messageId));
    return row ? hydrate(row) : undefined;
  }

  /** Решение владельца: approved | rejected | needs_edit — со следом «кто и когда». */
  decide(id, status, { by = null, note = null } = {}) {
    const info = this.#raw
      .prepare(
        `UPDATE approval_queue
            SET status = ?, decided_by = ?, decided_at = datetime('now'),
                edit_note = COALESCE(?, edit_note), updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(status, by, note, id);
    return info.changes > 0;
  }

  /** Пометить версию как заменённую новой (после правки) — из очереди она уходит, история остаётся. */
  markSuperseded(id) {
    return this.setStatus(id, 'superseded');
  }

  /**
   * Переписать meta элемента (T10: пути к перерендеренным картинкам).
   * Отдельный метод, а не общий «update»: meta — единственное поле, которое дописывают
   * ПОСЛЕ постановки в очередь, и делать это должен один понятный вызов.
   */
  setMeta(id, meta) {
    const info = this.#raw
      .prepare(`UPDATE approval_queue SET meta = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(meta ? JSON.stringify(meta) : null, id);
    return info.changes > 0;
  }

  /**
   * Переписать текст черновика. Нужен выбору варианта: Сценарист присылает 2–3 поста одним
   * ответом, владелец жмёт «Вариант N», и в элементе очереди остаётся ровно он — публикация
   * берёт `content` как есть и о вариантах ничего не знает. Исходный ответ агента при этом
   * сохраняется в meta (`variants_source`), чтобы можно было передумать.
   */
  setContent(id, content) {
    const info = this.#raw
      .prepare(`UPDATE approval_queue SET content = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(String(content ?? ''), id);
    return info.changes > 0;
  }

  /** Слот контент-календаря (ISO-строка). Заготовка под расписание публикации T08. */
  setSlot(id, slotAt) {
    const info = this.#raw
      .prepare(`UPDATE approval_queue SET slot_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(slotAt, id);
    return info.changes > 0;
  }

  /** Что ждёт решения владельца прямо сейчас. */
  listPending({ limit = 20 } = {}) {
    return this.list({ status: 'pending', limit });
  }

  /**
   * Всё, что двигалось начиная с даты — сырьё для отчёта Аналитика (T16).
   * Берём по «последнему движению» (публикация → правка → создание), а не по created_at:
   * черновик мог родиться на прошлой неделе, а решение по нему принять вчера.
   */
  listSince(since, { limit = 500 } = {}) {
    const rows = this.#raw
      .prepare(
        `SELECT * FROM approval_queue
          WHERE COALESCE(published_at, updated_at, created_at) >= ?
          ORDER BY id DESC LIMIT ?`,
      )
      .all(String(since), limit);
    return rows.map(hydrate);
  }

  /** Отложить публикацию до слота (T08): элемент одобрен, но время ещё не пришло. */
  markScheduled(id) {
    return this.setStatus(id, 'scheduled');
  }

  /**
   * Публикация состоялась: запоминаем, где искать пост, и время.
   * messageId — Telegram (число), ref — строковый id поста на площадке (IG/Threads: 18 цифр,
   * в число такое класть нельзя, см. миграцию 006).
   */
  markPublished(id, { messageId = null, ref = null } = {}) {
    const info = this.#raw
      .prepare(
        `UPDATE approval_queue
            SET status = 'published', published_message_id = ?, published_ref = ?,
                published_at = datetime('now'), publish_error = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(messageId, ref === null ? null : String(ref), id);
    return info.changes > 0;
  }

  /** Публикация не удалась: причина сохраняется, элемент можно попробовать опубликовать снова. */
  markPublishFailed(id, error) {
    const info = this.#raw
      .prepare(
        `UPDATE approval_queue
            SET status = 'publish_failed', publish_error = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(String(error ?? 'неизвестная ошибка'), id);
    return info.changes > 0;
  }

  /**
   * Отложенные элементы, чей слот уже наступил (для планировщика T08).
   * Сравнение строковое: слоты храним в ISO-подобном виде, время берём в том же формате.
   */
  listDueScheduled(nowIso, { limit = 10 } = {}) {
    const rows = this.#raw
      .prepare(
        `SELECT * FROM approval_queue
          WHERE status = 'scheduled' AND slot_at IS NOT NULL AND slot_at <= ?
          ORDER BY slot_at ASC LIMIT ?`,
      )
      .all(String(nowIso), limit);
    return rows.map(hydrate);
  }

  /** Сводка «сколько чего» по статусам очереди. */
  countsByStatus() {
    const rows = this.#raw.prepare('SELECT status, COUNT(*) AS n FROM approval_queue GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}

/**
 * Репозиторий задач, которые Продюсер раздаёт агентам (T05).
 * Диспетчер помнит статусы за Продюсера: у агента один проход через `claude -p`, доступа к БД нет.
 */
class TasksRepo {
  #raw;
  constructor(raw) {
    this.#raw = raw;
  }

  /** Поставить задачу в очередь исполнения. Возвращает id. */
  add({ agent, brief, goal = null, topicId = null, status = 'queued' }) {
    const info = this.#raw
      .prepare(
        `INSERT INTO tasks (agent, brief, goal, topic_id, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(agent, brief, goal, topicId, status);
    return Number(info.lastInsertRowid);
  }

  /** Одна задача по id (или undefined). */
  getById(id) {
    return this.#raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  }

  /** Список задач, опционально по статусу, новые сверху. */
  list({ status = null, limit = 50 } = {}) {
    return status
      ? this.#raw.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
      : this.#raw.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** Пометить «пошли исполнять». */
  markRunning(id) {
    return this.#setStatus(id, 'running');
  }

  /** Пометить «исполнено», сохранив краткую выжимку ответа. */
  markDone(id, result = null) {
    const info = this.#raw
      .prepare(`UPDATE tasks SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(result, id);
    return info.changes > 0;
  }

  /** Пометить «упало», сохранив текст ошибки. */
  markFailed(id, error) {
    const info = this.#raw
      .prepare(`UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(String(error ?? 'неизвестная ошибка'), id);
    return info.changes > 0;
  }

  /** Сводка «сколько чего» по статусам: { queued: 2, done: 5, … }. */
  countsByStatus() {
    const rows = this.#raw.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  #setStatus(id, status) {
    const info = this.#raw
      .prepare(`UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
    return info.changes > 0;
  }
}

/**
 * Репозиторий сбора трендов (T09): прогоны, собранные посты, темы из отчёта Разведчика.
 *
 * Дедуп и лимит «1 прогон/день» живут ЗДЕСЬ, а не в памяти процесса: перезапуск диспетчера не
 * должен разрешать второй прогон за сутки и не должен «забывать», какие посты уже разбирали.
 */
class TrendsRepo {
  #raw;
  constructor(raw) {
    this.#raw = raw;
  }

  /** Открыть прогон (status по умолчанию running). Возвращает id. */
  startRun({ day, provider, status = 'running', note = null }) {
    const info = this.#raw
      .prepare('INSERT INTO trend_runs (day, provider, status, note) VALUES (?, ?, ?, ?)')
      .run(String(day), String(provider), status, note);
    return Number(info.lastInsertRowid);
  }

  /** Закрыть прогон итогом: сколько нашли, сколько новых, сколько тем, чем кончилось. */
  finishRun(id, { status, postsFound = 0, postsNew = 0, topicsFound = 0, note = null } = {}) {
    const info = this.#raw
      .prepare(
        `UPDATE trend_runs
            SET status = ?, posts_found = ?, posts_new = ?, topics_found = ?,
                note = COALESCE(?, note), finished_at = datetime('now')
          WHERE id = ?`,
      )
      .run(status, Number(postsFound) || 0, Number(postsNew) || 0, Number(topicsFound) || 0, note, id);
    return info.changes > 0;
  }

  /**
   * Сколько прогонов уже было за эти сутки. `skipped` не считается: он ничего не собирал,
   * иначе один отказ по лимиту навсегда закрывал бы день.
   */
  countRunsOnDay(day) {
    const row = this.#raw
      .prepare(`SELECT COUNT(*) AS n FROM trend_runs WHERE day = ? AND status <> 'skipped'`)
      .get(String(day));
    return Number(row?.n || 0);
  }

  /** Один прогон по id (или undefined). */
  getRun(id) {
    return this.#raw.prepare('SELECT * FROM trend_runs WHERE id = ?').get(id);
  }

  /** Последние прогоны, новые сверху — для «/тренды статус» и разбора полётов. */
  listRuns({ limit = 10 } = {}) {
    return this.#raw.prepare('SELECT * FROM trend_runs ORDER BY id DESC LIMIT ?').all(limit);
  }

  /**
   * Записать собранные посты. Дубль по ссылке молча игнорируется (INSERT OR IGNORE) — это и есть
   * дедуп между прогонами: уже разобранный пост не уйдёт Разведчику второй раз.
   * @returns {{added:number, skipped:number}}
   */
  addPosts(runId, posts = []) {
    const stmt = this.#raw.prepare(
      `INSERT OR IGNORE INTO trend_posts
         (run_id, platform, url, author, text, likes, comments, views, posted_at, source_query)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const p of posts) {
      const info = stmt.run(
        runId ?? null,
        String(p.platform || ''),
        p.url ?? null,
        p.author ?? null,
        p.text ?? null,
        p.likes ?? null,
        p.comments ?? null,
        p.views ?? null,
        p.postedAt ?? null,
        p.sourceQuery ?? null,
      );
      if (info.changes > 0) added += 1;
    }
    return { added, skipped: posts.length - added };
  }

  /** Посты, реально записанные этим прогоном, — то есть только новые (дубли остались за старым run_id). */
  listPostsByRun(runId, { limit = 200 } = {}) {
    return this.#raw
      .prepare('SELECT * FROM trend_posts WHERE run_id = ? ORDER BY id ASC LIMIT ?')
      .all(runId, limit);
  }

  /** Сколько постов вообще накоплено (по ним и работает дедуп). */
  countPosts() {
    return Number(this.#raw.prepare('SELECT COUNT(*) AS n FROM trend_posts').get()?.n || 0);
  }

  /** Сохранить темы из отчёта Разведчика (topics[] его META-конверта). Возвращает число тем. */
  addTopics(runId, topics = []) {
    const stmt = this.#raw
      .prepare('INSERT INTO trend_topics (run_id, topic, why, angle) VALUES (?, ?, ?, ?)');
    let n = 0;
    for (const t of topics) {
      if (!t?.topic) continue;
      stmt.run(runId ?? null, String(t.topic), t.why ?? null, t.angle ?? null);
      n += 1;
    }
    return n;
  }

  /** Темы, новые сверху; unusedOnly — только те, по которым ещё не писали пост. */
  listTopics({ limit = 20, unusedOnly = false } = {}) {
    return unusedOnly
      ? this.#raw.prepare('SELECT * FROM trend_topics WHERE used = 0 ORDER BY id DESC LIMIT ?').all(limit)
      : this.#raw.prepare('SELECT * FROM trend_topics ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** Пометить тему отработанной (по ней уже поставлена задача Сценаристу). */
  markTopicUsed(id) {
    const info = this.#raw.prepare('UPDATE trend_topics SET used = 1 WHERE id = ?').run(id);
    return info.changes > 0;
  }
}

/**
 * Репозиторий PDF-лид-магнитов инста-воронки (T13).
 *
 * Строка на ТЕМУ, а не на прогон: воронке в ManyChat (T14) нужна ровно одна актуальная ссылка на
 * каждую из трёх тем. Пересборка перезаписывает строку — уже разосланная ссылка остаётся живой.
 */
class FunnelRepo {
  #raw;
  constructor(raw) {
    this.#raw = raw;
  }

  /** Записать (или перезаписать) собранный PDF темы. Возвращает ключ темы. */
  upsert({ key, title, file, url = null, pages = null, meta = null }) {
    this.#raw
      .prepare(
        `INSERT INTO funnel_pdfs (key, title, file, url, pages, meta, built_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           title = excluded.title, file = excluded.file, url = excluded.url,
           pages = excluded.pages, meta = excluded.meta, built_at = datetime('now')`,
      )
      .run(String(key), String(title), String(file), url, pages ?? null, meta ? JSON.stringify(meta) : null);
    return String(key);
  }

  /** Один PDF по ключу темы (или undefined). */
  getByKey(key) {
    const row = this.#raw.prepare('SELECT * FROM funnel_pdfs WHERE key = ?').get(String(key));
    return row ? hydrate(row) : undefined;
  }

  /**
   * Отметить, что ссылка темы записана в bot-поле ManyChat (T14).
   * Храним и имя поля, и само записанное значение: по нему видно расхождение со статикой, если
   * ссылку потом пересобрали, а синхронизацию не повторили.
   */
  markSynced({ key, field, url }) {
    const info = this.#raw
      .prepare(
        `UPDATE funnel_pdfs SET manychat_field = ?, manychat_url = ?, manychat_at = datetime('now')
         WHERE key = ?`,
      )
      .run(String(field), url ?? null, String(key));
    return info.changes > 0;
  }

  /** Все собранные PDF воронки, по порядку ключей — это и есть «что сейчас отдаёт воронка». */
  list() {
    return this.#raw.prepare('SELECT * FROM funnel_pdfs ORDER BY key ASC').all().map(hydrate);
  }
}

/** Внутренняя нормализация строки БД → объект приложения (JSON-поля разворачиваются). */
/**
 * Репозиторий заявок на монтаж (T16). Мост между VPS и ноутом клиента: заявка живёт в базе,
 * пока ноутбук сам её не заберёт — наружу VPS не стучится и портов не открывает.
 */
class VideoJobsRepo {
  #raw;
  constructor(raw) {
    this.#raw = raw;
  }

  /**
   * Создать заявку. Повторный вызов по тому же одобренному сценарию новую заявку НЕ создаёт —
   * возвращает уже существующую (уникальный индекс из миграции 009): «Одобрить» можно нажать
   * дважды, а монтировать дважды одно и то же не нужно.
   * @returns {{id:number, created:boolean}}
   */
  add({ queueId = null, title = null, script, note = null }) {
    if (queueId != null) {
      const existing = this.#raw.prepare('SELECT id FROM video_jobs WHERE queue_id = ?').get(queueId);
      if (existing) return { id: Number(existing.id), created: false };
    }
    const info = this.#raw
      .prepare('INSERT INTO video_jobs (queue_id, title, script, note) VALUES (?, ?, ?, ?)')
      .run(queueId, title, String(script ?? ''), note);
    return { id: Number(info.lastInsertRowid), created: true };
  }

  /** Одна заявка по id (или undefined). */
  getById(id) {
    return this.#raw.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id);
  }

  /** Заявки по статусу, старые сверху: монтируют в порядке поступления. */
  list({ status = 'open', limit = 50 } = {}) {
    return status
      ? this.#raw.prepare('SELECT * FROM video_jobs WHERE status = ? ORDER BY id ASC LIMIT ?').all(status, limit)
      : this.#raw.prepare('SELECT * FROM video_jobs ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** Заявка закрыта смонтированным роликом: resultQueueId — карточка этого ролика в очереди. */
  markDone(id, { resultQueueId = null, note = null } = {}) {
    const info = this.#raw
      .prepare(
        `UPDATE video_jobs
            SET status = 'done', result_queue_id = ?, note = COALESCE(?, note),
                updated_at = datetime('now')
          WHERE id = ? AND status != 'done'`,
      )
      .run(resultQueueId, note, id);
    return info.changes > 0;
  }

  /** Передумали монтировать. Заявка остаётся в истории — так видно, что решение было осознанным. */
  cancel(id, note = null) {
    const info = this.#raw
      .prepare(
        `UPDATE video_jobs SET status = 'cancelled', note = COALESCE(?, note),
                updated_at = datetime('now')
          WHERE id = ? AND status = 'open'`,
      )
      .run(note, id);
    return info.changes > 0;
  }

  /** Сводка «сколько чего» по статусам. */
  countsByStatus() {
    const rows = this.#raw.prepare('SELECT status, COUNT(*) AS n FROM video_jobs GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}

/**
 * Репозиторий снимков метрик (T16). По строке на ЗАМЕР: цифры растут во времени, и Аналитику
 * важна динамика, а не последнее значение (см. миграцию 010).
 */
class MetricsRepo {
  #raw;
  constructor(raw) {
    this.#raw = raw;
  }

  /** Записать замер. metrics — произвольный объект площадки, хранится JSON-строкой. */
  add({ queueId, platform, ref = null, metrics }) {
    const info = this.#raw
      .prepare('INSERT INTO post_metrics (queue_id, platform, ref, metrics) VALUES (?, ?, ?, ?)')
      .run(queueId, String(platform), ref === null ? null : String(ref), JSON.stringify(metrics ?? {}));
    return Number(info.lastInsertRowid);
  }

  /** Последний замер по элементу очереди (или undefined, если пост ещё не замеряли). */
  latestFor(queueId) {
    const row = this.#raw
      .prepare('SELECT * FROM post_metrics WHERE queue_id = ? ORDER BY collected_at DESC, id DESC LIMIT 1')
      .get(queueId);
    return row ? { ...row, metrics: safeParse(row.metrics) } : undefined;
  }

  /** Последние замеры пачкой: { queueId: {...метрики}, … } — так отчёт не делает N запросов. */
  latestByQueue(queueIds = []) {
    const out = {};
    for (const id of queueIds) {
      const row = this.latestFor(id);
      if (row) out[id] = row.metrics;
    }
    return out;
  }
}

/**
 * Служебные отметки планировщиков (T16): «когда последний раз отработало».
 * В памяти процесса такое держать нельзя — перезапуск диспетчера повторил бы работу.
 */
class StateRepo {
  #raw;
  constructor(raw) {
    this.#raw = raw;
  }

  /** Значение по ключу или null. */
  get(key) {
    const row = this.#raw.prepare('SELECT value FROM app_state WHERE key = ?').get(String(key));
    return row ? row.value : null;
  }

  /** Записать значение (перезаписывает существующее). */
  set(key, value) {
    this.#raw
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(String(key), value === null ? null : String(value));
    return true;
  }
}

function hydrate(row) {
  return { ...row, meta: row.meta ? safeParse(row.meta) : null };
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s, _parseError: true };
  }
}
