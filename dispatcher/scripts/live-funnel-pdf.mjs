// ЖИВОЙ прогон сборки PDF-лид-магнитов (T13): реальный Презентатор через `claude -p`,
// реальный бот, реальный топик.
//
// ⚠ Скрипт ПИШЕТ В ГРУППУ и ТРАТИТ ПО ВЫЗОВУ CLAUDE НА КАЖДУЮ ТЕМУ. Запускать осознанно:
//   cd dispatcher && npm run live:t13              # все темы из manychat/funnel.json
//   cd dispatcher && npm run live:t13 content-plan # только одна тема
//
// Что проверяет — весь срез тикета целиком:
//   темы из manychat/funnel.json → агент-Презентатор (claude -p) → структура страниц
//   → PDF в dispatcher/data/pdf → копия в публичную статику → ссылка в БД → файл в топик.
//
// Чего он НЕ покрывает: входящий хоп «человек пишет /пдф в топик Презентатора» (бот не слышит
// бота — проверяется руками в группе, как в T03) и раздачу ссылок в директе (это ManyChat, T14).

import { Bot } from 'grammy';
import { enabledIdentities } from '../src/bots/registry.js';
import { openDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { postToTopic } from '../src/bots/send.js';
import { buildFunnelPdfs, renderFunnelList, renderPdfReport } from '../src/funnel/pdf.js';
import { loadFunnel } from '../src/funnel/config.js';
import { findBrowser, NO_BROWSER_HINT } from '../../render/index.js';

const key = process.argv[2] || null;

if (!config.forumGroupId) throw new Error('FORUM_GROUP_ID не задан в .env');
const browser = findBrowser();
if (!browser) throw new Error(NO_BROWSER_HINT);
console.log(`Браузер для сборки PDF: ${browser}`);

const funnel = loadFunnel(config.funnelConfigPath);
if (!funnel.ok) throw new Error(funnel.error);
console.log(`Темы воронки (${funnel.topics.length}): ${funnel.topics.map((t) => t.key).join(', ')}`);
if (!config.publicDir || !config.publicBaseUrl) {
  console.warn('⚠️ PUBLIC_DIR/PUBLIC_BASE_URL не заданы — PDF соберутся, но публичных ссылок не будет.');
}

// Поднимаем только Презентатора: файлы уходят в его топик, других участников у сборки нет.
const identities = enabledIdentities().filter((i) => i.key === 'presenter');
const presenter = identities[0];
if (!presenter) throw new Error('Презентатор не поднят: нет BOT_TOKEN_PRESENTER в .env');
if (presenter.topicId == null) throw new Error('TOPIC_PRESENTER не задан в .env — файлам некуда идти');

const botsByKey = new Map(identities.map((i) => [i.key, { identity: i, bot: new Bot(i.token) }]));
const db = openDb();

await postToTopic(
  botsByKey.get('presenter').bot,
  config.forumGroupId,
  presenter.topicId,
  `📌 Живая проверка T13\n\nСобираю PDF${key ? ` по теме «${key}»` : ' по всем темам воронки'}…`,
);

console.log('Зову агента-Презентатора через claude -p (по вызову на тему, это небыстро)…');
const res = await buildFunnelPdfs({
  db,
  config,
  botsByKey,
  groupId: config.forumGroupId,
  key,
  onLog: (m) => console.log(m),
});

const report = renderPdfReport(res);
console.log(`\n${report}`);
await postToTopic(botsByKey.get('presenter').bot, config.forumGroupId, presenter.topicId, report);

console.log(`\nЧто сейчас отдаёт воронка:\n${renderFunnelList(db.funnel.list())}`);
db.close();

const built = res.results.filter((r) => r.ok).length;
console.log(built ? `\n✓ живая сборка прошла: PDF собрано ${built} — смотри файлы в топике Презентатора` : '\n✗ ни один PDF не собрался — см. причины выше');
