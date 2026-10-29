// Контракт вызова агента (T04). Диспетчер — «тупая труба»: он НЕ думает, а лишь собирает промпт
// из трёх кусков и отдаёт его в `claude -p`. Три куска:
//   1) инструкции агента       — agents/<key>.md (самодостаточный файл, уедет клиенту как есть);
//   2) «мозг бренда»           — весь brand-brain/ (пустые слоты = обезличенный контент, это ожидаемо);
//   3) задача                  — то, что прислал пользователь.
//
// Ответ агента возвращается по унифицированному конверту, чтобы диспетчер мог его разобрать
// и позже сложить в очередь согласования (T07):
//
//     <готовый к показу текст-черновик>
//     ---META---
//     { "kind": "tg_post", "status": "draft", "title": "..." }
//
// Строка ---META--- и JSON после неё необязательны: если их нет, весь вывод считается контентом
// (kind:"unknown"). Так контракт остаётся строгим для агентов, но устойчивым к «болтливым» ответам.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runClaude } from './claude.js';
import { AGENTS_DIR, BRAND_BRAIN_DIR } from './config.js';

export const META_SENTINEL = '---META---';

/** Читает brand-brain/: все *.md кроме README, помечает пустые слоты. Возвращает {text, filled, total}. */
export async function loadBrandBrain(dir = BRAND_BRAIN_DIR) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { text: '(brand-brain отсутствует)', filled: 0, total: 0 };
  }
  const files = entries.filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').sort();

  const parts = [];
  let filled = 0;
  for (const file of files) {
    const raw = await fsp.readFile(path.join(dir, file), 'utf8');
    const meaningful = stripTemplate(raw);
    if (meaningful) filled += 1;
    parts.push(`### ${file}\n${meaningful ? raw.trim() : '(слот пуст — клиент ещё не заполнил)'}`);
  }
  return {
    text: parts.length ? parts.join('\n\n') : '(в brand-brain нет файлов-слотов)',
    filled,
    total: files.length,
  };
}

/** Убирает markdown-комментарии <!-- ... --> и пробелы, чтобы понять, есть ли реальное содержимое. */
function stripTemplate(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#.*$/gm, '') // заголовки-слоты не считаем содержимым
    .trim();
}

/** Собирает финальный промпт для claude -p. Вынесено отдельно — легко юнит-тестировать. */
export function buildAgentPrompt({ agentInstructions, brandBrain, task }) {
  return [
    'Ты — агент контент-конвейера. Ниже: твоя роль, «мозг бренда» и задача.',
    'Строго следуй роли. Опирайся на «мозг бренда»; если слот пуст — работай, но контент будет',
    'обезличенным (это ожидаемо до наполнения клиентом). Ничего не выдумывай сверх фактов бренда.',
    '',
    'ФОРМАТ ОТВЕТА (обязательно): сперва готовый к показу результат, затем на отдельной строке',
    `«${META_SENTINEL}», затем ОДНА строка валидного JSON с полями kind, status, title.`,
    '',
    '════════ РОЛЬ АГЕНТА ════════',
    agentInstructions.trim(),
    '',
    '════════ МОЗГ БРЕНДА ════════',
    brandBrain.text,
    '',
    '════════ ЗАДАЧА ════════',
    task.trim(),
  ].join('\n');
}

/** Разбирает вывод агента на {content, meta} по конверту ---META---. Устойчив к отсутствию конверта. */
export function parseAgentResponse(text) {
  const marker = `\n${META_SENTINEL}`;
  const idx = text.lastIndexOf(marker);
  if (idx === -1) {
    return { content: text.trim(), meta: { kind: 'unknown', status: 'draft' } };
  }
  const content = text.slice(0, idx).trim();
  const metaRaw = text.slice(idx + marker.length).trim();
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    meta = { kind: 'unknown', status: 'draft', _metaParseError: true };
  }
  return { content, meta };
}

/**
 * Полный прогон агента по контракту.
 * @param {object} o
 * @param {string} o.agentKey        имя файла в agents/ без .md (напр. 'writer').
 * @param {string} o.task            текст задачи от пользователя.
 * @param {string} [o.agentsDir]     где искать файл агента (default: AGENTS_DIR).
 * @param {string} [o.brandBrainDir] где искать brand-brain (default: BRAND_BRAIN_DIR).
 * @param {Function} [o.claudeRunner] инъекция для тестов (default: runClaude).
 * @returns {Promise<{ok:boolean, content?:string, meta?:object, raw?:string, brandFilled?:number, brandTotal?:number, error?:string}>}
 */
export async function runAgent({
  agentKey,
  task,
  agentsDir = AGENTS_DIR,
  brandBrainDir = BRAND_BRAIN_DIR,
  claudeRunner = runClaude,
}) {
  let agentInstructions;
  try {
    agentInstructions = await fsp.readFile(path.join(agentsDir, `${agentKey}.md`), 'utf8');
  } catch {
    return { ok: false, error: `нет файла агента agents/${agentKey}.md` };
  }

  const brandBrain = await loadBrandBrain(brandBrainDir);
  const prompt = buildAgentPrompt({ agentInstructions, brandBrain, task });

  const r = await claudeRunner({ prompt });
  if (!r.ok) return { ok: false, error: r.error };

  const { content, meta } = parseAgentResponse(r.text);
  return {
    ok: true,
    content,
    meta,
    raw: r.text,
    brandFilled: brandBrain.filled,
    brandTotal: brandBrain.total,
  };
}
