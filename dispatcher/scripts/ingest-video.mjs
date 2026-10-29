// Приём смонтированного ролика на VPS (T15). Запускается НА СЕРВЕРЕ, после того как файл уже
// приехал туда по scp с ноута клиента:
//
//   cd /opt/content-pipeline/dispatcher
//   npm run ingest:video -- --file /tmp/reels.mp4 --caption-file /tmp/caption.txt --title "Тема"
//
// Обычно эту команду запускает не человек, а локальный Claude Code с ноута одной строкой через
// ssh — см. video/README.md и video/upload.sh.
//
// Что делает: кладёт ролик в публичную статику (Instagram качает Reels по video_url, файл он не
// принимает) и ставит карточку согласования в топик Издателя. Наружу ничего не публикуется —
// публикация будет только после кнопки «Одобрить», как и у всего остального контента.
//
// ⚠ Скрипт ПИШЕТ В БОЕВУЮ БАЗУ и шлёт сообщение в группу, но денег не тратит: `claude -p` здесь
// не зовётся вообще — ролик уже смонтирован, думать не над чем.

import fs from 'node:fs';
import { Bot } from 'grammy';
import { enabledIdentities } from '../src/bots/registry.js';
import { openDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { ingestVideo, renderIngestReport } from '../src/video/ingest.js';
import { closeJobWithVideo } from '../src/video/jobs.js';

const args = parseArgs(process.argv.slice(2));

if (!args.file) {
  console.error(
    [
      'Приём готового ролика в очередь согласования (T15).',
      '',
      'Использование:',
      '  npm run ingest:video -- --file <путь к ролику на VPS> [опции]',
      '',
      'Опции:',
      '  --caption "<текст>"     подпись под Reels',
      '  --caption-file <путь>   подпись из файла (удобно для многострочного текста)',
      '  --title "<тема>"        как черновик подписан в карточке и в «/очередь»',
      '  --slot "2026-09-10 10:00"   отложить публикацию до слота календаря',
      '  --job <N>               закрыть заявку на монтаж номер N (см. npm run video:jobs)',
      '  --keep                  не удалять исходный файл после приёма',
    ].join('\n'),
  );
  process.exit(1);
}

const caption = args['caption-file']
  ? fs.readFileSync(args['caption-file'], 'utf8')
  : (args.caption ?? '');

// Нужен только бот Издателя: карточка висит в его топике, он же ловит нажатия кнопок.
// Long polling здесь НЕ запускается — это разовый вызов API, боевому диспетчеру он не мешает.
const publisher = enabledIdentities().find((i) => i.key === 'publisher');
const botsByKey = publisher
  ? new Map([['publisher', { identity: publisher, bot: new Bot(publisher.token) }]])
  : new Map();
if (!publisher) console.warn('⚠ BOT_TOKEN_PUBLISHER не задан — карточка не появится, но черновик в очередь встанет');

const db = openDb();
const res = await ingestVideo({
  db,
  file: args.file,
  caption,
  title: args.title ?? null,
  slotAt: args.slot ?? null,
  botsByKey,
  groupId: config.forumGroupId,
});
// Заявка на монтаж (T16) закрывается тем же заливом: круг «сценарий → монтаж → ролик» замыкается
// здесь, а не в голове у человека. Без --job приём работает как раньше — ролик можно смонтировать
// и без заявки.
if (res.ok && args.job) {
  const closed = closeJobWithVideo({ db, jobId: Number(args.job), resultQueueId: res.id });
  console.log(closed.ok ? `заявка #${args.job} закрыта` : `⚠️ заявка не закрыта: ${closed.error}`);
}

db.close();

console.log(renderIngestReport(res));
if (!res.ok) process.exit(1);

// Копия ролика уже лежит в веб-корне, исходник в /tmp больше не нужен: место на VPS не бесконечное,
// а ноут держит у себя и проект монтажа, и мастер-файл.
if (!args.keep) {
  try {
    fs.rmSync(args.file);
    console.log('исходник удалён с VPS (копия отдаётся из статики; --keep оставит его на месте)');
  } catch (err) {
    console.warn(`не удалось удалить исходник ${args.file}: ${err.message}`);
  }
}

/** Разбор `--ключ значение` и флагов вида `--keep`. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
