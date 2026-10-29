// Нормализация выдачи актора (T09): «что бы актор ни отдал» → один и тот же вид поста.
//
// Зачем слой: у каждого актора Apify свои имена полей (caption / text / postText, likesCount /
// likes / stats.likes), и клиент может сменить актор в любой момент. Всё, что дальше по конвейеру
// (БД, дедуп, материал для Разведчика), должно видеть ОДИН формат:
//
//   { platform, url, author, text, likes, comments, views, postedAt, sourceQuery, raw }
//
// Автоопределение покрывает типовые имена; нестандартные задаются в sources.json → map.

/** Типовые имена полей у популярных акторов. Проверяются по порядку, берётся первое непустое. */
export const DEFAULT_MAP = {
  url: ['url', 'postUrl', 'permalink', 'link', 'shortUrl'],
  author: ['ownerUsername', 'username', 'authorUsername', 'author.username', 'user.username', 'owner.username', 'author'],
  text: ['caption', 'text', 'postText', 'description', 'title', 'content'],
  likes: ['likesCount', 'likeCount', 'likes', 'stats.likes'],
  comments: ['commentsCount', 'commentCount', 'comments', 'stats.comments', 'replies'],
  views: ['videoViewCount', 'videoPlayCount', 'viewsCount', 'playCount', 'views'],
  postedAt: ['timestamp', 'takenAt', 'taken_at_timestamp', 'publishedAt', 'createdAt', 'date', 'time'],
};

/** Значение по «пути с точками» (author.username). Пустая строка и null считаются «нет значения». */
export function pickPath(obj, path) {
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur === '' || cur === null ? undefined : cur;
}

/** Первое непустое значение из списка кандидатов (сначала клиентские, потом типовые). */
export function pick(raw, candidates = []) {
  for (const path of candidates) {
    const v = pickPath(raw, path);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Число из чего угодно: массив → его длина (некоторые акторы кладут в comments сам массив). */
export function toCount(v) {
  if (Array.isArray(v)) return v.length;
  if (v === null || v === undefined || v === '') return null; // «нет данных» ≠ «ноль лайков»
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Дата поста → 'YYYY-MM-DD'. Понимает ISO-строку, миллисекунды и unix-секунды. */
export function toDate(v) {
  if (v == null) return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000; // >1e12 — уже миллисекунды
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Один элемент датасета → пост единого вида. null, если это не пост (нет ни ссылки, ни текста). */
export function normalizePost(raw, { platform, map = {}, sourceQuery = null } = {}) {
  const field = (name) => pick(raw, [...(map[name] || []), ...DEFAULT_MAP[name]]);
  const url = field('url');
  const text = field('text');
  if (!url && !text) return null;

  const author = field('author');
  return {
    platform,
    url: url ? String(url) : null,
    author: author ? String(typeof author === 'object' ? author.username || author.name || '' : author) : null,
    text: text ? String(text).trim() : '',
    likes: toCount(field('likes')),
    comments: toCount(field('comments')),
    views: toCount(field('views')),
    postedAt: toDate(field('postedAt')),
    sourceQuery,
    raw,
  };
}

/**
 * Датасет → посты. Отбрасывает мусор и дубли внутри прогона (по ссылке, а при её отсутствии — по тексту).
 * @param {object[]} items элементы датасета актора
 */
export function normalizeItems(items, { platform, map = {}, resolveSource = () => null } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const sourceQuery = resolveSource(raw);
    const post = normalizePost(raw, { platform, map, sourceQuery });
    if (!post) continue;
    if (!post.url && !post.text) continue;
    const key = post.url || `text:${post.text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(post);
  }
  return out;
}

/** Урезает выборку до потолка прогона, оставляя самые заметные (лайки+комментарии). */
export function topPosts(posts, maxPosts) {
  if (!Number.isFinite(maxPosts) || posts.length <= maxPosts) return posts;
  return [...posts]
    .sort((a, b) => (b.likes || 0) + (b.comments || 0) - ((a.likes || 0) + (a.comments || 0)))
    .slice(0, maxPosts);
}

/**
 * Материал для Разведчика: компактный дайджест постов.
 * Тексты режутся — агенту нужен смысл, а не полные простыни, и это экономит вызов claude -p.
 */
export function buildDigest(posts, { textLimit = 400 } = {}) {
  const lines = [];
  for (const p of posts) {
    const head = [
      p.platform === 'ig' ? 'IG' : 'Threads',
      p.author ? `@${p.author}` : null,
      p.sourceQuery && p.sourceQuery !== `@${p.author}` ? `из ${p.sourceQuery}` : null,
      p.postedAt,
      Number.isFinite(p.likes) && p.likes !== null ? `♥ ${p.likes}` : null,
      Number.isFinite(p.comments) && p.comments !== null ? `💬 ${p.comments}` : null,
      Number.isFinite(p.views) && p.views !== null ? `👁 ${p.views}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const body = p.text.length > textLimit ? `${p.text.slice(0, textLimit)}…` : p.text;
    lines.push(`--- ${head} ---\n${body || '(без текста)'}${p.url ? `\n${p.url}` : ''}`);
  }
  return lines.join('\n\n');
}

/** Разбор ответа Разведчика: темы из META-конверта (`topics[]` по контракту agents/scout.md). */
export function parseTopicsFromMeta(meta) {
  const raw = Array.isArray(meta?.topics) ? meta.topics : [];
  return raw
    .map((t) => ({
      topic: String(t?.topic || '').trim(),
      why: String(t?.why || '').trim() || null,
      angle: String(t?.angle || '').trim() || null,
    }))
    .filter((t) => t.topic);
}
