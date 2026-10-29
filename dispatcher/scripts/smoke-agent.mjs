// Смоук-тест контракта агента (T04) БЕЗ реального Claude Code: подставляем фейковый claudeRunner
// и проверяем (а) сборку промпта, (б) парсинг конверта ---META---, (в) разный результат при
// пустом vs заполненном brand-brain. Запуск: node dispatcher/scripts/smoke-agent.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, parseAgentResponse, META_SENTINEL } from '../src/agent.js';

// --- парсинг конверта ---
const withMeta = parseAgentResponse(`Черновик поста\n${META_SENTINEL}\n{"kind":"tg_post","status":"draft"}`);
assert.equal(withMeta.content, 'Черновик поста', 'контент отделён от meta');
assert.equal(withMeta.meta.kind, 'tg_post', 'meta распарсен');

const noMeta = parseAgentResponse('Просто текст без конверта');
assert.equal(noMeta.content, 'Просто текст без конверта', 'без конверта весь текст = контент');
assert.equal(noMeta.meta.kind, 'unknown', 'без конверта kind=unknown');

// --- окружение: временный агент + два варианта brand-brain (пустой и заполненный) ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-agent-'));
const agentsDir = path.join(root, 'agents');
const empty = path.join(root, 'brain-empty');
const filled = path.join(root, 'brain-filled');
fs.mkdirSync(agentsDir); fs.mkdirSync(empty); fs.mkdirSync(filled);
fs.writeFileSync(path.join(agentsDir, 'demo.md'), '# Demo\nТы — тестовый агент.');
fs.writeFileSync(path.join(empty, '00-brand.md'), '# Бренд\n<!-- слот: заполнит клиент -->');
fs.writeFileSync(path.join(filled, '00-brand.md'), '# Бренд\nМиссия: КОФЕЙНЯ-XYZ, дерзкий тон.');

// Фейковый раннер: «контент» зависит от того, попал ли бренд в промпт → доказываем влияние brand-brain.
const MARK = 'КОФЕЙНЯ-XYZ';
const fakeRunner = async ({ prompt }) => ({
  ok: true,
  text: `${prompt.includes(MARK) ? 'Персональный пост про КОФЕЙНЮ-XYZ' : 'Обезличенный пост'}\n${META_SENTINEL}\n{"kind":"tg_post","status":"draft"}`,
});

const resEmpty = await runAgent({ agentKey: 'demo', task: 'тема: осень', agentsDir, brandBrainDir: empty, claudeRunner: fakeRunner });
const resFilled = await runAgent({ agentKey: 'demo', task: 'тема: осень', agentsDir, brandBrainDir: filled, claudeRunner: fakeRunner });

assert.equal(resEmpty.brandFilled, 0, 'пустой brand-brain: 0 заполненных слотов');
assert.equal(resFilled.brandFilled, 1, 'заполненный brand-brain: 1 слот');
assert.notEqual(resEmpty.content, resFilled.content, 'результат отличается при empty vs filled');
assert.match(resFilled.content, /КОФЕЙНЮ-XYZ/, 'при заполненном бренде контент персонализирован');

// отсутствующий файл агента → аккуратная ошибка, а не краш
const missing = await runAgent({ agentKey: 'нет-такого', task: 'x', agentsDir, brandBrainDir: empty, claudeRunner: fakeRunner });
assert.equal(missing.ok, false, 'нет файла агента → ok:false');

fs.rmSync(root, { recursive: true, force: true });
console.log('✓ smoke-agent PASS — конверт парсится, brand-brain влияет на результат');
