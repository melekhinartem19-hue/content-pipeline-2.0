// Низкоуровневый вызов Claude Code как подпроцесса — ЕДИНСТВЕННАЯ точка «интеллекта».
//
// Правило CLAUDE.md #1: Node НИКОГДА не ходит в Anthropic API напрямую. Только `claude -p`
// на Pro-подписке клиента. Здесь нет и не должно быть ни одного HTTP-запроса к API.
//
// Промпт подаётся через stdin (проверено: `echo "..." | claude -p` работает) — это снимает
// лимит длины аргумента командной строки и избавляет от экранирования шелла.

import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * Коды выхода Windows, означающие «процесс вообще не стартовал» — не наша логика, а нехватка
 * ресурсов машины (много одновременных процессов, десктоп-хип, память). Лечится повтором.
 * Проверено вживую: 0xC0000142 прилетал при десятке параллельных claude.exe/cmd.exe.
 */
export const TRANSIENT_EXIT_CODES = new Map([
  [3221225794, '0xC0000142 STATUS_DLL_INIT_FAILED — Windows не смог инициализировать подпроцесс'],
  [3221225495, '0xC0000017 STATUS_NO_MEMORY — не хватило памяти на запуск подпроцесса'],
]);

/** Сколько раз всего пробуем запустить claude при транзиентном отказе старта. */
const START_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Вызов Claude Code с повтором при транзиентном отказе запуска (см. TRANSIENT_EXIT_CODES).
 * Сигнатура и результат — как у одиночного прогона.
 * @param {object} o
 * @param {string}   o.prompt        Полный промпт для Claude Code.
 * @param {string}   [o.claudeBin]   Команда запуска (default: config.claudeBin).
 * @param {number}   [o.timeoutMs]   Тайм-аут, мс (default: config.claudeTimeoutMs).
 * @param {string}   [o.cwd]         Рабочая папка подпроцесса (default: config.claudeCwd).
 * @param {string[]} [o.args]        Полный список аргументов (default: ['-p']). Для тестов.
 * @param {number}   [o.attempts]    Сколько попыток старта (default: START_ATTEMPTS). Для тестов.
 * @param {Map}      [o.transientCodes]  Таблица «отказ старта → подсказка» (default: TRANSIENT_EXIT_CODES).
 *   Только для тестов: коды в таблице — виндовые, а Linux усекает код выхода до 8 бит, поэтому
 *   подделать 0xC0000142 подпроцессом там невозможно и механику повтора нечем было бы проверить.
 * @returns {Promise<{ok:boolean, text:string, error?:string, code?:number|null, timedOut?:boolean, attempts?:number}>}
 */
export async function runClaude({ attempts = START_ATTEMPTS, transientCodes = TRANSIENT_EXIT_CODES, ...opts } = {}) {
  let last;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    last = await runClaudeOnce(opts);
    const hint = transientCodes.get(last.code);
    if (last.ok || !hint) return attempt > 1 ? { ...last, attempts: attempt } : last;

    console.warn(`[claude] попытка ${attempt}/${attempts} не стартовала (${hint})`);
    if (attempt < attempts) await sleep(RETRY_DELAY_MS * attempt);
    else last = { ...last, error: `${hint}. Не удалось запустить за ${attempts} попыт(ки). Обычно помогает закрыть лишние процессы claude/node и повторить.` };
  }
  return { ...last, attempts };
}

/**
 * Один запуск подпроцесса. Вынесен отдельно, чтобы повтор в runClaude оставался тривиальным.
 * @returns {Promise<{ok:boolean, text:string, error?:string, code?:number|null, timedOut?:boolean}>}
 */
export async function runClaudeOnce({ prompt, claudeBin, timeoutMs, cwd, args } = {}) {
  const bin = claudeBin || config.claudeBin;
  const t = Number(timeoutMs || config.claudeTimeoutMs);
  const workdir = cwd || config.claudeCwd;
  const argv = args || ['-p'];

  // На Windows «голую» команду (напр. `claude`) в PATH резолвит как .cmd-шим только shell.
  // Для абсолютных путей/путей с разделителями shell не нужен (и он ломается на пробелах,
  // напр. "Program Files"). На Linux/VPS shell не нужен вовсе.
  const isBareCommand = !bin.includes('/') && !bin.includes('\\');
  const useShell = process.platform === 'win32' && isBareCommand;

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      // При shell:true передаём команду одной строкой (argv статичны и безопасны) — это обходит
      // DEP0190 (args + shell) и корректно резолвит .cmd-шим на Windows.
      child = useShell
        ? spawn([bin, ...argv].join(' '), { cwd: workdir, shell: true })
        : spawn(bin, argv, { cwd: workdir, shell: false });
    } catch (err) {
      finish({ ok: false, text: '', error: `spawn failed: ${err.message}` });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      // На Windows под shell:true мы убиваем cmd.exe, а НЕ его внуков (claude → node): они
      // остаются висеть и копятся, а копятся процессы — приходит 0xC0000142 на следующем старте.
      // taskkill /T /F валит всё дерево. На Linux/VPS хватает обычного kill.
      if (useShell && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {
          child.kill('SIGKILL');
        });
      } else {
        child.kill('SIGKILL');
      }
    }, t);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      finish({ ok: false, text: '', error: `process error: ${err.message}` });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish({ ok: false, text: stdout.trim(), error: `timeout after ${t}ms`, timedOut: true, code });
      } else if (code === 0) {
        finish({ ok: true, text: stdout.trim(), code });
      } else {
        finish({ ok: false, text: stdout.trim(), error: stderr.trim() || `exit code ${code}`, code });
      }
    });

    // Подаём промпт в stdin и закрываем поток. EPIPE игнорируем (подпроцесс мог упасть раньше).
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
