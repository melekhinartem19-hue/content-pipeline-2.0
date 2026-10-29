// Смоук-тест враппера claude.js (T01) БЕЗ реального Claude Code: вместо `claude` подставляем
// node-заглушку и проверяем механику подпроцесса — захват stdout, ненулевой код, тайм-аут.
// Запуск: node dispatcher/scripts/smoke-claude.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude, TRANSIENT_EXIT_CODES } from '../src/claude.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-claude-'));
const stub = (name, code) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, code);
  return p;
};

// 1) Успех: заглушка читает stdin и печатает его обратно → ok, text = промпт.
const echo = stub('echo.mjs', `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d));`);
const ok = await runClaude({ prompt: '  ping  ', claudeBin: process.execPath, args: [echo] });
assert.equal(ok.ok, true, 'успешный прогон → ok:true');
assert.equal(ok.text, 'ping', 'stdout захвачен и обрезан');

// 2) Ошибка: ненулевой код + stderr → ok:false, error содержит текст stderr.
const fail = stub('fail.mjs', `process.stderr.write('boom');process.exit(1);`);
const bad = await runClaude({ prompt: 'x', claudeBin: process.execPath, args: [fail] });
assert.equal(bad.ok, false, 'ненулевой код → ok:false');
assert.match(bad.error, /boom/, 'stderr прокинут в error');

// 3) Тайм-аут: заглушка висит → timedOut:true, ok:false.
const hang = stub('hang.mjs', `setInterval(()=>{},1000);`);
const to = await runClaude({ prompt: 'x', claudeBin: process.execPath, args: [hang], timeoutMs: 400 });
assert.equal(to.ok, false, 'зависание → ok:false');
assert.equal(to.timedOut, true, 'выставлен флаг timedOut');

// 4) Транзиентный отказ старта: пробуем ещё раз, а не сдаёмся сразу.
//
// ПОЧЕМУ НЕ ПРЯМО 0xC0000142. Коды в TRANSIENT_EXIT_CODES виндовые (3221225794), а POSIX отдаёт код
// выхода одним байтом: на Linux `process.exit(3221225794)` доезжает как 66, повтор не включается —
// и тест падал бы на ровном месте. Ровно это и поймал первый прогон на VPS. Поэтому саму механику
// повтора проверяем на своём коде через transientCodes, а боевую таблицу — отдельным ассертом.
const TRANSIENT_CODE = 7;
const codes = new Map([[TRANSIENT_CODE, 'тестовый отказ старта']]);

assert.ok(TRANSIENT_EXIT_CODES.has(3221225794), 'в боевой таблице есть код 0xC0000142');
assert.match(TRANSIENT_EXIT_CODES.get(3221225794), /0xC0000142/, 'подсказка называет виндовый код');
assert.ok(TRANSIENT_EXIT_CODES.has(3221225495), 'в боевой таблице есть 0xC0000017 (нет памяти)');

// Заглушка отдаёт транзиентный код на первых запусках и успешна на третьем — счётчик в файле.
const flaky = stub(
  'flaky.mjs',
  `import fs from 'node:fs';
   const counter = process.argv[2];
   const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
   fs.writeFileSync(counter, String(n));
   if (n < 3) process.exit(${TRANSIENT_CODE});
   process.stdout.write('стартовал с ' + n + '-й попытки');`,
);
const counter = path.join(dir, 'attempts.txt');
const retried = await runClaude({
  prompt: 'x', claudeBin: process.execPath, args: [flaky, counter], transientCodes: codes,
});
assert.equal(retried.ok, true, 'после повторов запуск удался');
assert.equal(retried.attempts, 3, 'сработали ровно три попытки');
assert.match(retried.text, /стартовал с 3-й попытки/, 'вернулся результат успешной попытки');

// Если транзиентный код не проходит совсем — ошибка объясняет, что делать.
const alwaysDead = stub('dead.mjs', `process.exit(${TRANSIENT_CODE});`);
const dead = await runClaude({
  prompt: 'x', claudeBin: process.execPath, args: [alwaysDead], attempts: 2, transientCodes: codes,
});
assert.equal(dead.ok, false, 'постоянный отказ старта → ok:false');
assert.match(dead.error, /тестовый отказ старта/, 'в ошибке названа причина отказа');
assert.match(dead.error, /закрыть лишние процессы/, 'есть подсказка, что делать');

// Обычная ошибка агента повторами не размазывается — код 1 отдаётся сразу.
const failAgain = await runClaude({ prompt: 'x', claudeBin: process.execPath, args: [fail] });
assert.equal(failAgain.attempts, undefined, 'при обычной ошибке повторов не было');

fs.rmSync(dir, { recursive: true, force: true });
console.log('✓ smoke-claude PASS — stdout/ошибка/тайм-аут и повтор при отказе старта');
