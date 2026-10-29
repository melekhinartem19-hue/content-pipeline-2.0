// Демо контракта агента (T04) на РЕАЛЬНОМ Claude Code. Показывает главное: один и тот же
// агент-заглушка даёт РАЗНЫЙ результат при пустом vs заполненном brand-brain.
//
// Требует, чтобы `claude` был доступен и залогинен (Pro-подписка). Делает 2 вызова claude -p.
// Запуск:  node dispatcher/scripts/demo-agent-contract.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/agent.js';
import { BRAND_BRAIN_DIR } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.join(__dirname, '..', 'test-fixtures', 'agents');
const filledDir = path.join(__dirname, '..', 'test-fixtures', 'brand-brain-filled');

const task = 'Тема: как мы обжариваем кофе. Напиши пост.';

console.log('▶ Прогон 1 — ПУСТОЙ brand-brain (реальный brand-brain/, слоты не заполнены)\n');
const empty = await runAgent({ agentKey: 'demo-writer', task, agentsDir, brandBrainDir: BRAND_BRAIN_DIR });
printResult(empty);

console.log('\n▶ Прогон 2 — ЗАПОЛНЕННЫЙ brand-brain (фикстура «Тёплый угол»)\n');
const filled = await runAgent({ agentKey: 'demo-writer', task, agentsDir, brandBrainDir: filledDir });
printResult(filled);

console.log('\n— Ожидаемо: во 2-м прогоне пост персонализирован под бренд, в 1-м — обезличен.');

function printResult(r) {
  if (!r.ok) {
    console.log('  ⚠️ Ошибка:', r.error);
    return;
  }
  console.log(`  слотов заполнено: ${r.brandFilled}/${r.brandTotal}`);
  console.log('  ── контент ──');
  console.log(r.content.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('  ── meta ──');
  console.log('  ', JSON.stringify(r.meta));
}
