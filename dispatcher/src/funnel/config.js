// Конфиг инста-воронки (T13/T14): три фиксированные темы → три PDF-лид-магнита.
//
// Разделение ответственности такое же, как у трендов: ЧТО собирать — данные клиента (видимый
// manychat/funnel.json), а код лишь читает, проверяет и превращает тему в задачу Презентатору.
// Тексты тем клиент меняет сам, не трогая ни строчки кода.
//
// ПОЧЕМУ РОВНО ТРИ. Матчинг темы в воронке — три кнопки/ключа без ИИ-классификации (правило
// CLAUDE.md): дешевле и не мажет. Поэтому число тем фиксирует конфиг, а не решение агента —
// у Презентатора в agents/presenter.md это прямо записано в границах роли.
//
// Здесь только чистые функции и чтение файла: ни Telegram, ни БД, ни claude -p — чтобы конфиг
// проверялся смоуком оффлайн.

import fs from 'node:fs';

/** Сколько тем в воронке. Больше — лишние кнопки в директе, меньше — недоиспользованная воронка. */
export const FUNNEL_TOPICS = 3;

/** Ключ темы: латиница, цифры и дефис. Он же имя файла и часть публичной ссылки. */
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Читает и проверяет manychat/funnel.json.
 * Отсутствие файла — НЕ ошибка кода, а «клиент ещё не настроил»: возвращаем ok:false с внятным
 * текстом для топика и ничего не тратим (три вызова claude -p стоят денег и времени).
 * @returns {{ok:boolean, path:string, topics?:object[], manychat?:object, note?:string, error?:string}}
 */
export function loadFunnel(file, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!exists(file)) {
    return {
      ok: false,
      path: file,
      error:
        'воронка не настроена: нет manychat/funnel.json. Скопируй manychat/funnel.example.json → ' +
        'manychat/funnel.json и впиши свои три темы (см. manychat/README.md).',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFile(file, 'utf8'));
  } catch (err) {
    return { ok: false, path: file, error: `manychat/funnel.json не читается как JSON: ${err.message}` };
  }

  const check = validateFunnel(parsed);
  if (!check.ok) return { ok: false, path: file, error: check.error };

  return { ok: true, path: file, topics: check.topics, manychat: parsed.manychat || {}, note: check.note };
}

/**
 * Проверка структуры конфига. Ловим ДО траты вызовов claude: пустую тему, кривой ключ, дубли.
 * @returns {{ok:boolean, topics?:object[], note?:string, error?:string}}
 */
export function validateFunnel(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'пустой конфиг воронки' };
  if (!Array.isArray(cfg.topics)) return { ok: false, error: 'в конфиге нет списка topics' };

  const raw = cfg.topics.filter((t) => t && typeof t === 'object');
  if (!raw.length) return { ok: false, error: 'в конфиге нет ни одной темы' };

  const topics = [];
  const seen = new Set();
  const words = new Set();
  for (const [i, t] of raw.entries()) {
    const key = String(t.key || '').trim();
    if (!KEY_RE.test(key)) {
      return {
        ok: false,
        error: `тема #${i + 1}: ключ «${key || '(пусто)'}» не годится — нужна латиница, цифры и дефис (он станет именем файла и частью ссылки)`,
      };
    }
    if (seen.has(key)) return { ok: false, error: `ключ «${key}» встречается дважды — ссылки на PDF совпадут` };
    seen.add(key);

    const title = String(t.title || '').trim();
    if (!title) return { ok: false, error: `тема «${key}»: пустое поле title` };
    const brief = String(t.brief || '').trim();
    if (!brief) return { ok: false, error: `тема «${key}»: пустое поле brief — Презентатору не из чего собирать` };

    // Ключевое слово — триггер в директе (T14). Пустое поле не ошибка (тему можно собрать и до
    // настройки воронки), а вот два одинаковых слова — ошибка: ManyChat не поймёт, какой из двух
    // PDF отдавать, и человек молча получит чужой материал.
    const keyword = String(t.keyword || '').trim() || null;
    if (keyword) {
      const low = keyword.toLowerCase();
      if (words.has(low)) {
        return { ok: false, error: `ключевое слово «${keyword}» стоит у двух тем — воронка не поймёт, что отдавать` };
      }
      words.add(low);
    }

    topics.push({
      key,
      title,
      brief,
      keyword,
      // Подпись кнопки в директе. Пусто = берётся из title (см. buttonLabel в reply.js): у Instagram
      // подпись кнопки короткая, а название темы часто длинное.
      button: String(t.button || '').trim() || null,
      pages: Number.isFinite(Number(t.pages)) && Number(t.pages) > 0 ? Number(t.pages) : null,
    });
  }

  // Отклонение от трёх — не ошибка (пусть клиент сначала запустит одну тему), но молчать нельзя:
  // воронка в ManyChat рассчитана ровно на три кнопки.
  const note =
    topics.length === FUNNEL_TOPICS
      ? null
      : `в конфиге тем: ${topics.length}, а воронка рассчитана на ${FUNNEL_TOPICS} (три кнопки в директе)`;

  return { ok: true, topics, note };
}

/** Тема по ключу (или null). Регистр не важен — в топик команду пишет человек. */
export function findTopic(topics, key) {
  const needle = String(key || '').trim().toLowerCase();
  return topics.find((t) => t.key.toLowerCase() === needle) || null;
}

/**
 * Тема → задача Презентатору. Всё, что знает про формулировку задачи, живёт здесь: агент получает
 * ровно эти строки плюс свою роль и brand-brain (промпт собирает src/agent.js).
 */
export function topicTask(topic) {
  const lines = [
    `Собери структуру PDF-лид-магнита по теме: «${topic.title}».`,
    `О чём материал и для кого: ${topic.brief}`,
  ];
  if (topic.pages) lines.push(`Ориентир по объёму: ${topic.pages} страниц (обложка и финальная страница считаются).`);
  lines.push('Это одна из фиксированных тем инста-воронки — материал должен быть самодостаточным.');
  return lines.join('\n');
}

/** Имя файла PDF для темы. Ключ уже проверен регуляркой, поэтому склейка безопасна. */
export function pdfFileName(topic) {
  return `${topic.key}.pdf`;
}
