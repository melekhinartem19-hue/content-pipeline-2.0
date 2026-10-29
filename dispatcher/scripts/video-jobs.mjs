// Заявки на монтаж, ждущие ноутбука (T16). Запускается НА VPS, обычно не руками, а по ssh
// с ноута — см. video/pull-jobs.sh.
//
//   npm run video:jobs            # человекочитаемый список
//   npm run video:jobs -- --json  # JSON: это читает локальный Claude Code на ноуте
//
// Только чтение: ничего не публикует, `claude -p` не зовёт, денег не тратит.

import { openDb } from '../src/db/index.js';
import { jobsAsJson, renderJobsList } from '../src/video/jobs.js';

const json = process.argv.includes('--json');
const db = openDb();
const jobs = db.videoJobs.list({ status: 'open' });

console.log(json ? jobsAsJson(jobs) : renderJobsList(jobs, db.videoJobs.countsByStatus()));
db.close();
