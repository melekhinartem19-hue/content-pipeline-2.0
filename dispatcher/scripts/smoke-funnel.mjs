// Смоук-тест связки «темы воронки → PDF → статика → БД → топик» (T13).
// Оффлайн: вместо Telegram — фейковый бот, вместо claude -p и браузера — подставные функции.
// Запуск: node dispatcher/scripts/smoke-funnel.mjs
//
// Сама печать PDF проверяется в smoke-pdf.mjs. Здесь проверяется ДИСПЕТЧЕРСКАЯ часть: что
// читается из конфига, что уходит агенту, куда копируются файлы, что попадает в БД и что
// происходит, когда одна тема упала, а статика не настроена.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { FUNNEL_TOPICS, findTopic, loadFunnel, pdfFileName, topicTask, validateFunnel } from '../src/funnel/config.js';
import {
  buildFunnelPdfs,
  documentCaption,
  parsePdfCommand,
  renderFunnelList,
  renderPdfReport,
} from '../src/funnel/pdf.js';

// ── Команда ───────────────────────────────────────────────────────────────
assert.deepEqual(parsePdfCommand('/пдф'), { all: true, list: false, key: null }, 'сборка всех тем');
assert.deepEqual(parsePdfCommand('пдф'), { all: true, list: false, key: null }, 'без слэша тоже команда');
assert.deepEqual(parsePdfCommand('/pdf all'), { all: true, list: false, key: null }, 'латинский вариант');
assert.equal(parsePdfCommand('/пдф content-plan').key, 'content-plan', 'пересборка одной темы');
assert.equal(parsePdfCommand('/пдф список').list, true, 'список собранного');
assert.equal(parsePdfCommand('пдфка на завтра'), null, 'похожий текст командой не считается');

// ── Конфиг воронки ────────────────────────────────────────────────────────
assert.equal(FUNNEL_TOPICS, 3, 'воронка рассчитана на три кнопки');

const bad = [
  [{ topics: [] }, /нет ни одной темы/],
  [{ topics: [{ key: 'Плохой', title: 'a', brief: 'b' }] }, /не годится/],
  [{ topics: [{ key: 'a', title: '', brief: 'b' }] }, /пустое поле title/],
  [{ topics: [{ key: 'a', title: 't', brief: '' }] }, /пустое поле brief/],
  [
    { topics: [{ key: 'a', title: 't', brief: 'b' }, { key: 'a', title: 't', brief: 'b' }] },
    /встречается дважды/,
  ],
];
for (const [cfg, re] of bad) {
  const res = validateFunnel(cfg);
  assert.equal(res.ok, false, `конфиг отклонён: ${re}`);
  assert.match(res.error, re, 'причина понятна человеку');
}

// Тем не три — не ошибка, но об этом говорится вслух: воронка рассчитана на три кнопки.
const two = validateFunnel({ topics: [{ key: 'a', title: 't', brief: 'b' }, { key: 'c', title: 't', brief: 'b' }] });
assert.equal(two.ok, true, 'две темы собрать можно');
assert.match(two.note, /воронка рассчитана на 3/, 'но про три кнопки сказано');

// ── Стенд: временный конфиг, папки и фейки ────────────────────────────────
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-funnel-'));
const funnelFile = path.join(root, 'funnel.json');
await fsp.writeFile(
  funnelFile,
  JSON.stringify({
    topics: [
      { key: 'plan', title: 'План на месяц', keyword: 'план', pages: 6, brief: 'Как собрать контент-план.' },
      { key: 'hooks', title: 'Крючки для Reels', keyword: 'reels', brief: 'Из чего состоят первые три секунды.' },
      { key: 'sales', title: 'Продающий пост', keyword: 'продажи', brief: 'Структура поста без давления.' },
    ],
  }),
  'utf8',
);

const loaded = loadFunnel(funnelFile);
assert.equal(loaded.ok, true, 'конфиг прочитан');
assert.equal(loaded.topics.length, 3, 'три темы');
assert.equal(pdfFileName(loaded.topics[0]), 'plan.pdf', 'имя файла — из ключа темы');
assert.equal(findTopic(loaded.topics, 'HOOKS').key, 'hooks', 'поиск темы без учёта регистра');
assert.match(topicTask(loaded.topics[0]), /План на месяц/, 'название темы уходит в задачу');
assert.match(topicTask(loaded.topics[0]), /6 страниц/, 'ориентир по объёму уходит в задачу');
assert.ok(!/страниц/.test(topicTask(loaded.topics[1])), 'без поля pages про объём не выдумываем');

assert.match(loadFunnel(path.join(root, 'нет.json')).error, /воронка не настроена/, 'нет файла — понятная причина');

function stand({ withStatic = true, failOn = null } = {}) {
  const sent = [];
  const bot = {
    api: {
      sendDocument: async (chatId, file, opts) => {
        sent.push({ chatId, file, opts });
        return { message_id: sent.length };
      },
    },
  };
  const config = {
    funnelConfigPath: funnelFile,
    pdfsDir: path.join(root, 'out'),
    brandBrainDir: path.join(root, 'brand-brain'),
    pdfPublicSubdir: 'funnel',
    publicDir: withStatic ? path.join(root, 'www') : null,
    publicBaseUrl: withStatic ? 'https://media.example.com/' : null,
  };

  // Подставной агент: отдаёт структуру, как настоящий Презентатор, и считает свои вызовы.
  const calls = [];
  const agentRunner = async ({ agentKey, task }) => {
    calls.push({ agentKey, task });
    if (failOn && task.includes(failOn)) return { ok: false, error: 'claude не стартовал' };
    return { ok: true, content: '=== СТРАНИЦА 1 ===\nЗаголовок: Тест', meta: { kind: 'pdf_spec', pages: 1 } };
  };

  // Подставной рендер: настоящий браузер здесь не нужен, но файл на диске появиться обязан —
  // иначе копирование в публичную папку проверялось бы понарошку.
  const renderer = async ({ outFile, title }) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `%PDF-1.4 ${title}`);
    return { ok: true, file: outFile, pages: 5, truncated: 0, note: 'страниц: 5' };
  };

  const botsByKey = new Map([['presenter', { bot, identity: { key: 'presenter', topicId: 47 } }]]);
  return { sent, config, calls, agentRunner, renderer, botsByKey };
}

// ── Сборка всех тем ───────────────────────────────────────────────────────
const db = openDb(':memory:');
const s = stand();
const res = await buildFunnelPdfs({
  db,
  config: s.config,
  botsByKey: s.botsByKey,
  groupId: -100123,
  agentRunner: s.agentRunner,
  renderer: s.renderer,
});

assert.equal(res.ok, true, 'сборка прошла');
assert.equal(res.results.length, 3, 'по результату на тему');
assert.ok(res.results.every((r) => r.ok), 'все три собрались');
assert.equal(s.calls.length, 3, 'ровно три вызова агента — по одному на тему, без лишних трат');
assert.ok(s.calls.every((c) => c.agentKey === 'presenter'), 'зовётся именно Презентатор');

// Файлы легли в публичную папку и получили https-адрес: без этого воронке нечего отдать.
assert.equal(res.results[0].url, 'https://media.example.com/funnel/plan.pdf', 'ссылка собрана из PUBLIC_BASE_URL');
assert.ok(fs.existsSync(path.join(s.config.publicDir, 'funnel', 'plan.pdf')), 'файл скопирован в статику');
assert.ok(res.results.every((r) => !r.warn), 'предупреждений нет');

// Готовые документы ушли в топик Презентатора (а не в чужой и не в личку).
assert.equal(s.sent.length, 3, 'три документа отправлены');
assert.equal(s.sent[0].chatId, -100123, 'в форум-группу');
assert.equal(s.sent[0].opts.message_thread_id, 47, 'в топик Презентатора');
assert.match(s.sent[0].opts.caption, /https:\/\/media\.example\.com/, 'ссылка видна прямо под файлом');

// В БД — строка на тему, с актуальной ссылкой.
const rows = db.funnel.list();
assert.equal(rows.length, 3, 'в базе три темы');
assert.deepEqual(rows.map((r) => r.key), ['hooks', 'plan', 'sales'], 'ключи тем на месте');
assert.equal(db.funnel.getByKey('plan').pages, 5, 'число страниц сохранено');
assert.match(renderFunnelList(rows), /План на месяц \(plan\)/, 'список читаемый');
assert.match(renderPdfReport(res), /Итого собрано: 3 из 3/, 'в отчёте виден итог');

// ── Пересборка одной темы: ссылка та же, вызов агента один ────────────────
const s2 = stand();
const one = await buildFunnelPdfs({
  db,
  config: s2.config,
  botsByKey: s2.botsByKey,
  groupId: -100123,
  key: 'plan',
  agentRunner: s2.agentRunner,
  renderer: s2.renderer,
});
assert.equal(one.results.length, 1, 'собрана одна тема');
assert.equal(s2.calls.length, 1, 'и агент вызван один раз');
assert.equal(db.funnel.list().length, 3, 'пересборка не плодит строки — ключ темы это первичный ключ');
assert.equal(db.funnel.getByKey('plan').url, 'https://media.example.com/funnel/plan.pdf', 'ссылка осталась прежней');

const missing = await buildFunnelPdfs({ db, config: s2.config, key: 'нет-такой', agentRunner: s2.agentRunner });
assert.equal(missing.ok, false, 'неизвестная тема не собирается');
assert.match(missing.error, /нет в manychat\/funnel\.json/, 'и подсказывает, какие темы есть');
assert.match(renderPdfReport(missing), /Сборка PDF не пошла/, 'отчёт про это говорит');

// ── Одна тема упала — остальные собрались ─────────────────────────────────
const db3 = openDb(':memory:');
const s3 = stand({ failOn: 'Крючки' });
const partial = await buildFunnelPdfs({
  db: db3,
  config: s3.config,
  botsByKey: s3.botsByKey,
  groupId: -100123,
  agentRunner: s3.agentRunner,
  renderer: s3.renderer,
});
assert.equal(partial.ok, true, 'сбой одной темы не отменяет сборку');
assert.equal(partial.results.filter((r) => r.ok).length, 2, 'две темы собраны');
assert.match(partial.results[1].error, /агент не ответил/, 'причина сбоя сохранена');
assert.equal(db3.funnel.list().length, 2, 'в базе только удавшиеся');
assert.match(renderPdfReport(partial), /Итого собрано: 2 из 3/, 'отчёт честно считает');

// ── Публичной статики нет: файлы есть, ссылок нет ─────────────────────────
const db4 = openDb(':memory:');
const s4 = stand({ withStatic: false });
const noStatic = await buildFunnelPdfs({
  db: db4,
  config: s4.config,
  botsByKey: s4.botsByKey,
  groupId: -100123,
  agentRunner: s4.agentRunner,
  renderer: s4.renderer,
});
assert.ok(noStatic.results.every((r) => r.ok), 'PDF всё равно собираются');
assert.ok(noStatic.results.every((r) => !r.url), 'но ссылок нет');
assert.match(noStatic.results[0].warn, /нет публичной статики/, 'причина названа у каждой темы');
assert.equal(db4.funnel.getByKey('plan').url, null, 'в базе ссылка пустая, а не выдуманная');
assert.match(renderPdfReport(noStatic), /PUBLIC_DIR/, 'отчёт подсказывает, что настроить');
assert.match(
  documentCaption({ key: 'plan', title: 'План' }, { pages: 5, note: 'страниц: 5' }),
  /Тема воронки: plan/,
  'подпись под файлом без ссылки не ломается',
);

// ── Бот Презентатора не поднят: файл собран, но человек его не увидит ─────
const db5 = openDb(':memory:');
const s5 = stand();
const noSeat = await buildFunnelPdfs({
  db: db5,
  config: s5.config,
  botsByKey: new Map(),
  groupId: -100123,
  key: 'plan',
  agentRunner: s5.agentRunner,
  renderer: s5.renderer,
});
assert.equal(noSeat.results[0].ok, true, 'PDF всё равно собран');
assert.match(noSeat.results[0].warn, /TOPIC_PRESENTER/, 'сказано, что файл в топик не ушёл и где он лежит');
db5.close();

// ── Конфига нет вовсе ─────────────────────────────────────────────────────
const none = await buildFunnelPdfs({ db: db4, config: { ...s4.config, funnelConfigPath: path.join(root, 'нет.json') } });
assert.equal(none.ok, false, 'без конфига сборка не идёт');
assert.match(none.error, /воронка не настроена/, 'и объясняет, что скопировать');
assert.equal(s4.calls.length, 3, 'вызовов агента при этом не прибавилось — деньги не потрачены');

db.close();
db3.close();
db4.close();
await fsp.rm(root, { recursive: true, force: true });

console.log('✅ smoke-funnel: конфиг тем, сборка, статика, БД и отчёт — ок');
