// Что воронка отдаёт человеку в директе (T14): три ключа → три ссылки на PDF.
//
// Здесь только ЧИСТЫЕ функции: имя поля ManyChat, текст ответа, карточка настройки, разбор
// команды. Ни HTTP, ни БД, ни Telegram — поэтому вся логика воронки проверяется смоуком
// оффлайн, без аккаунта ManyChat (его у нас и нет: аккаунт клиента, см. CLAUDE.md).
//
// КАК УСТРОЕНА ВОРОНКА (решение владельца 07.09.2026 — push в bot fields):
//
//   /пдф → PDF в статике → URL в БД ──(API ManyChat)──▶ bot field pdf_<ключ>
//                                                              │
//   человек жмёт кнопку «План» во флоу ManyChat ───────────────┘
//                                     └─▶ «Держи материал — {{pdf_content_plan}}»
//
// Флоу с тремя кнопками собирает человек в UI ManyChat один раз: API ManyChat не умеет создавать
// флоу, только читать и писать поля. Поэтому наша часть — отдать точные названия полей, кнопок и
// текстов (карточка настройки) и держать в полях актуальные ссылки (синхронизация, manychat.js).
//
// ПОЧЕМУ ССЫЛКА, А НЕ ФАЙЛ. Файл-PDF в Instagram-директ отправить технически невозможно (правило 3
// CLAUDE.md) — ни через ManyChat, ни через сырой API. Отдаём ссылку на Nginx-статику или уводим
// в Telegram. Это ограничение площадки, а не недоделка.

/** Префикс bot-полей ManyChat по умолчанию: pdf_content_plan, pdf_reels_hooks, … */
export const DEFAULT_FIELD_PREFIX = 'pdf_';

/** Текст ответа по умолчанию, если в конфиге воронки не задан свой. */
export const DEFAULT_TEMPLATE = 'Держи материал по теме «{title}» — {url}';

/** Лимит подписи кнопки в Instagram: длиннее ManyChat обрежет сам, и подпись потеряет смысл. */
export const BUTTON_LIMIT = 20;

/** Лимит текста одного сообщения в инста-директе. */
export const DM_LIMIT = 1000;

/**
 * Настройки воронки из секции `manychat` файла funnel.json — с умолчаниями.
 * Ключи, начинающиеся с `_`, в конфиге это комментарии, сюда они не попадают.
 */
export function funnelSettings(manychat = {}) {
  return {
    replyTemplate: String(manychat?.replyTemplate || '').trim() || DEFAULT_TEMPLATE,
    fallbackTelegram: String(manychat?.fallbackTelegram || '').trim() || null,
  };
}

/**
 * Ключ темы → имя bot-поля ManyChat: `content-plan` → `pdf_content_plan`.
 * Дефис меняется на подчёркивание: в названиях полей ManyChat дефис читается плохо и легко
 * путается с минусом в выражениях флоу.
 */
export function botFieldName(key, prefix = DEFAULT_FIELD_PREFIX) {
  return `${String(prefix || '')}${String(key || '').trim().toLowerCase().replace(/-/g, '_')}`;
}

/** Подпись кнопки: своя из конфига или название темы. Обрезку не делаем — про длину предупреждаем. */
export function buttonLabel(topic) {
  return topic.button || topic.title;
}

/**
 * Текст, который уходит человеку в директ.
 *
 * @param {object} o
 * @param {object} o.topic      тема воронки
 * @param {string|null} o.url   публичная ссылка на PDF (из БД)
 * @param {object} o.settings   результат funnelSettings()
 * @param {string|null} [o.placeholder] чем подставить ссылку вместо реального адреса —
 *   для карточки настройки это `{{pdf_content_plan}}`: во флоу ManyChat подставляет поле сам
 * @returns {{text:string, source:'pdf'|'field'|'telegram'|'none', warn:string|null}}
 */
export function funnelReply({ topic, url = null, settings = funnelSettings(), placeholder = null }) {
  const link = placeholder || url || settings.fallbackTelegram;
  const source = placeholder ? 'field' : url ? 'pdf' : settings.fallbackTelegram ? 'telegram' : 'none';

  if (!link) {
    return {
      text: '',
      source,
      warn:
        `«${topic.title}»: отдавать нечего — PDF ещё не собран (команда «/пдф») либо не настроена ` +
        'публичная статика (PUBLIC_DIR/PUBLIC_BASE_URL). Запасной вариант — увод в Telegram ' +
        '(поле manychat.fallbackTelegram в funnel.json)',
    };
  }

  const text = fill(settings.replyTemplate, {
    title: topic.title,
    url: link,
    keyword: topic.keyword || '',
    button: buttonLabel(topic),
  });

  const warns = [];
  if (source === 'telegram') warns.push('ссылки на PDF нет — уводим в Telegram');
  if (text.length > DM_LIMIT) warns.push(`текст длиннее ${DM_LIMIT} символов — инста-директ его обрежет`);
  return { text, source, warn: warns.join(' · ') || null };
}

/** Подстановка {title}/{url}/{keyword}/{button}. Неизвестные фигурные скобки остаются как есть. */
function fill(template, values) {
  return String(template).replace(/\{(title|url|keyword|button)\}/g, (_, k) => values[k] ?? '');
}

/**
 * Свод «конфиг воронки + собранные PDF» — единая картина, из которой живут и отчёты, и синхронизация.
 * Строки БД приходят из db.funnel.list(); темы, которых ещё нет в БД, попадают сюда с url = null.
 *
 * @param {object} o
 * @param {object[]} o.topics  темы из funnel.json
 * @param {object[]} [o.rows]  строки funnel_pdfs
 * @param {string} [o.prefix]  префикс bot-полей
 * @param {object} [o.settings]
 * @returns {object[]} по элементу на тему: тема, поле, ссылка, текст ответа, предупреждения
 */
export function funnelView({ topics, rows = [], prefix = DEFAULT_FIELD_PREFIX, settings = funnelSettings() }) {
  const byKey = new Map(rows.map((r) => [String(r.key), r]));
  return topics.map((topic) => {
    const row = byKey.get(topic.key) || null;
    const url = row?.url || null;
    const live = funnelReply({ topic, url, settings });
    const flow = funnelReply({ topic, url, settings, placeholder: `{{${botFieldName(topic.key, prefix)}}}` });

    const warns = [];
    if (!topic.keyword) warns.push('нет ключевого слова (поле keyword в funnel.json) — триггер в директе задать нечем');
    if (buttonLabel(topic).length > BUTTON_LIMIT) {
      warns.push(`подпись кнопки длиннее ${BUTTON_LIMIT} символов — задай короткую в поле button`);
    }
    if (!row) warns.push('PDF ещё не собран — команда «/пдф»');
    else if (!url) warns.push('PDF собран, но публичной ссылки нет — задай PUBLIC_DIR и PUBLIC_BASE_URL');
    // Про «отдавать нечего» уже сказано строкой выше — второй раз тем же словами не повторяем.
    if (live.warn && live.source !== 'none') warns.push(live.warn);

    // Расхождение статики и ManyChat: в поле лежит не та ссылка, что мы отдаём сейчас. Так бывает
    // после смены PUBLIC_BASE_URL — в директ уходит старый адрес, и человек получает 404.
    const synced = row?.manychat_url || null;
    const value = url || settings.fallbackTelegram || null;
    if (synced && value && synced !== value) {
      warns.push(`в ManyChat записана другая ссылка (${synced}) — обнови командой «/воронка синх»`);
    }

    return {
      key: topic.key,
      title: topic.title,
      keyword: topic.keyword,
      button: buttonLabel(topic),
      field: botFieldName(topic.key, prefix),
      url,
      value, // что реально уйдёт в bot-поле: ссылка на PDF или увод в Telegram
      builtAt: row?.built_at || null,
      syncedUrl: synced,
      syncedAt: row?.manychat_at || null,
      reply: live.text,
      flowText: flow.text,
      source: live.source,
      warns,
    };
  });
}

/** «/воронка» — что воронка отдаёт прямо сейчас. Чтение из БД, ни агента, ни ManyChat не трогаем. */
export function renderFunnelState(view, { hasToken = false, dryRun = false } = {}) {
  if (!view.length) return '⚠️ В manychat/funnel.json нет тем — воронке нечего отдавать.';

  const lines = ['🧲 Инста-воронка сейчас:'];
  for (const t of view) {
    const mark = t.value ? '✅' : '⚠️';
    lines.push(`${mark} ${t.title} (${t.key})`);
    lines.push(`   ключевое слово: ${t.keyword || '— не задано'} · кнопка: «${t.button}»`);
    lines.push(`   поле ManyChat: {{${t.field}}}${t.syncedAt ? ` · записано ${t.syncedAt}` : ' · в ManyChat не записано'}`);
    lines.push(`   ссылка: ${t.value || 'нет'}`);
    for (const w of t.warns) lines.push(`   ⚠️ ${w}`);
  }

  const ready = view.filter((t) => t.value).length;
  lines.push(`Готово к выдаче: ${ready} из ${view.length}.`);
  if (!hasToken) {
    lines.push(
      'ℹ️ MANYCHAT_TOKEN не задан — ссылки в ManyChat записать нечем. Пока их можно вставить во флоу ' +
        'руками: «/воронка настройка».',
    );
  } else if (dryRun) {
    lines.push('ℹ️ MANYCHAT_DRY_RUN=1 — синхронизация только печатает план, в ManyChat ничего не уходит.');
  } else {
    lines.push('Записать ссылки в ManyChat — «/воронка синх». Инструкция по настройке — «/воронка настройка».');
  }
  return lines.join('\n');
}

/**
 * «/воронка настройка» — пошаговая карточка для UI ManyChat.
 * Флоу собирает человек: API ManyChat умеет только поля, кнопки и триггеры создаются руками.
 * Поэтому здесь ровно те строки, которые нужно скопировать, — и ни одной, которую надо выдумать.
 */
export function renderSetupCard(view, { hasToken = false } = {}) {
  if (!view.length) return '⚠️ В manychat/funnel.json нет тем — настраивать нечего.';

  const lines = [
    '🧩 Настройка воронки в ManyChat (делается один раз, в UI):',
    '',
    `1) Settings → Bot Fields: создай ${view.length} текстовых поля с такими именами —`,
  ];
  for (const t of view) lines.push(`   ${t.field}`);
  lines.push(
    hasToken
      ? '   Значения в них запишет диспетчер: команда «/воронка синх».'
      : '   Значения впиши руками (они ниже) либо задай MANYCHAT_TOKEN в .env и вызови «/воронка синх».',
  );

  lines.push('', '2) Automation → новый Flow с сообщением и кнопками (по кнопке на тему):');
  for (const t of view) {
    lines.push(`   • Кнопка «${t.button}»  →  ответ:`);
    lines.push(`     ${t.flowText || '(ссылки пока нет — сначала «/пдф»)'}`);
  }

  lines.push('', '3) Automation → Keywords: слово в директе открывает тот же ответ —');
  for (const t of view) {
    lines.push(`   ${t.keyword ? `«${t.keyword}»` : '— ключевое слово не задано'}  →  «${t.button}»`);
  }

  lines.push(
    '',
    '4) Проверка: напиши боту ключевое слово из списка — должна прийти ссылка именно на свой PDF.',
    `   Что придёт по каждому ключу, видно командой «/воронка тест ${view[0].keyword || view[0].key}».`,
  );

  const missing = view.filter((t) => !t.value);
  if (missing.length) {
    lines.push('', `⚠️ Без ссылки пока: ${missing.map((t) => t.key).join(', ')} — сначала «/пдф».`);
  }
  lines.push(
    '',
    'ℹ️ Файл-PDF в инста-директ отправить нельзя — только ссылку. Это ограничение Instagram, ' +
      'настройкой ManyChat не обходится.',
  );
  return lines.join('\n');
}

/**
 * «/воронка тест план» — репетиция: что человек получит по этому ключу.
 * Матчинг ровно тот же, что в воронке, — по ключевому слову или ключу темы, без ИИ-классификации
 * (правило CLAUDE.md: три кнопки/ключа, дешевле и не мажет).
 */
export function renderFunnelTest(view, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return '⚠️ Укажи ключевое слово или ключ темы: «/воронка тест план».';

  const hit = view.find((t) => t.keyword?.toLowerCase() === needle) || view.find((t) => t.key.toLowerCase() === needle);
  if (!hit) {
    const known = view.map((t) => t.keyword || t.key).join(', ');
    return `⚠️ По «${query}» воронка ничего не отдаст: такого ключа нет. Есть: ${known}.`;
  }

  const lines = [`🧲 Ключ «${query}» → тема «${hit.title}» (${hit.key})`, '', 'В директ уйдёт:', hit.reply || '(ничего)'];
  if (hit.source === 'telegram') lines.push('', 'ℹ️ Это увод в Telegram: ссылки на PDF нет.');
  if (!hit.reply) lines.push('', `⚠️ ${hit.warns.join(' · ')}`);
  return lines.join('\n');
}

/**
 * Разбирает «/воронка», «/воронка синх», «/воронка настройка», «/воронка тест план».
 * @returns {{action:'state'|'sync'|'setup'|'test', key:string|null}|null} null, если это не команда
 */
export function parseFunnelCommand(text) {
  const m = /^\/?(воронка|funnel)(?:\s+([\wа-яё-]+))?(?:\s+([\wа-яё-]+))?\s*$/iu.exec(String(text || '').trim());
  if (!m) return null;
  const arg = (m[2] || '').trim().toLowerCase();
  const rest = (m[3] || '').trim().toLowerCase() || null;

  if (!arg) return { action: 'state', key: null };
  if (['синх', 'sync', 'синхр', 'обнови', 'обновить'].includes(arg)) return { action: 'sync', key: null };
  if (['настройка', 'setup', 'инструкция'].includes(arg)) return { action: 'setup', key: null };
  if (['тест', 'test', 'проверь', 'проверка'].includes(arg)) return { action: 'test', key: rest };
  // «/воронка план» без слова «тест» читается так же: человек спрашивает про конкретный ключ.
  return { action: 'test', key: arg };
}
