import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const e = process.env;
export const config = {
  port: +(e.PORT || 8080),
  dbPath: resolve(ROOT, e.DB_PATH || './data/hyetaek.db'),
  apiKey: e.DATA_GO_KR_KEY || '',
  gov24Base: (e.GOV24_BASE || 'https://api.odcloud.kr/api').replace(/\/$/, ''),
  adminToken: e.ADMIN_TOKEN || '',
  syncHour: e.SYNC_HOUR === undefined ? 4 : +e.SYNC_HOUR,
  smtp: { host: e.SMTP_HOST, port: +(e.SMTP_PORT || 587), user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.MAIL_FROM },
};
