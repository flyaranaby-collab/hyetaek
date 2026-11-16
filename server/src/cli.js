// 명령행: node src/cli.js sync [full] | notify
import { config } from './config.js';
import { openDb } from './db.js';
import { loadCurated } from './repo.js';
import { Gov24Client } from './gov24.js';
import { syncGov24 } from './sync.js';
import { buildNotifications, sendEmails } from './notify.js';
import { exportStatic } from './export.js';
import { P as CURATED } from '../../data/catalog.mjs';

const [cmd, arg] = process.argv.slice(2);
const db = openDb(config.dbPath);
loadCurated(db, CURATED);
if (cmd === 'sync') {
  const client = new Gov24Client({ base: config.gov24Base, apiKey: config.apiKey });
  const out = await syncGov24(db, client, { mode: arg === 'full' ? 'full' : 'incremental' });
  process.exit(out.ok ? 0 : 1);
} else if (cmd === 'notify') {
  console.log('알림 생성', buildNotifications(db), await sendEmails(db, config.smtp));
} else if (cmd === 'export') {
  console.log('정적 데이터 내보내기', exportStatic(db, arg || '../site/data'));
} else {
  console.log('사용법: npm run sync | npm run sync:full | npm run notify | node src/cli.js export <폴더>');
}
