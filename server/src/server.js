import { createServer } from 'node:http';
import { config } from './config.js';
import { openDb, getMeta, setMeta } from './db.js';
import { loadCurated } from './repo.js';
import { Gov24Client } from './gov24.js';
import { syncGov24 } from './sync.js';
import { buildNotifications, sendEmails } from './notify.js';
import { createApp } from './app.js';
import { P as CURATED } from '../../data/catalog.mjs';

const db = openDb(config.dbPath);
const cur = loadCurated(db, CURATED);
console.log(`[boot] 큐레이션 사업 반영: 신규 ${cur.created}, 변경 ${cur.updated}`);

let client = null;
if (config.apiKey) client = new Gov24Client({ base: config.gov24Base, apiKey: config.apiKey });
else console.warn('[boot] DATA_GO_KR_KEY 없음 — 큐레이션 데이터만으로 동작합니다 (.env 참고)');
if (!config.adminToken || config.adminToken.startsWith('change-me')) console.warn('[boot] ADMIN_TOKEN을 안전한 값으로 설정하세요. 관리자 API가 잠겨 있습니다.');
const appConfig = { ...config, adminToken: config.adminToken.startsWith('change-me') ? '' : config.adminToken };

createServer(createApp({ db, config: appConfig, gov24Client: client })).listen(config.port, () => {
  console.log(`[boot] http://localhost:${config.port}  (관리자: /admin)`);
});

// 매일 SYNC_HOUR시에 증분 수집(일요일은 전체 수집) + 알림 생성
async function daily() {
  const today = new Date().toISOString().slice(0, 10);
  if (new Date().getHours() !== config.syncHour || getMeta(db, 'daily_run') === today) return;
  setMeta(db, 'daily_run', today);
  if (client) await syncGov24(db, client, { mode: new Date().getDay() === 0 ? 'full' : 'incremental' });
  const n = buildNotifications(db);
  const mail = await sendEmails(db, config.smtp);
  console.log(`[daily] 알림 ${n}건 생성`, mail);
}
setInterval(() => daily().catch(err => console.error('[daily] 오류', err)), 10 * 60 * 1000);
daily().catch(() => {});
// 최초 실행 시 데이터가 없으면 바로 전체 수집
if (client && !getMeta(db, 'gov24_last_sync')) syncGov24(db, client, { mode: 'full' }).catch(() => {});
