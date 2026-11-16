// HTTP 앱 (의존성 없는 node:http 기반). 공개 API + 관리자 API + 정적 파일
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { ROOT } from './config.js';
import { nowIso, getMeta } from './db.js';
import { listPrograms, getProgram } from './repo.js';
import { evaluate, statusOf } from '../../data/logic.mjs';
import { buildNotifications, sendEmails } from './notify.js';
import { syncGov24 } from './sync.js';

const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const UUID_RE = /^[0-9a-f-]{16,64}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'content-type': isObj ? 'application/json; charset=utf-8' : (headers['content-type'] || 'text/plain; charset=utf-8'),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function readJson(req, max = 32 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('요청이 너무 큽니다'), { code: 413 }); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 형식 오류'), { code: 400 }); }
}

// 간단한 IP별 요청 제한 (분당 120회)
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now(), b = buckets.get(ip) || { n: 0, t: now };
  if (now - b.t > 60000) { b.n = 0; b.t = now; }
  b.n++; buckets.set(ip, b);
  if (buckets.size > 10000) buckets.clear();
  return b.n > 120;
}

function isAdmin(req, token) {
  if (!token) return false;
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const cleanProfile = (p = {}) => ({
  region: typeof p.region === 'string' ? p.region.slice(0, 10) : '',
  city: typeof p.city === 'string' ? p.city.slice(0, 10) : '',
  age: Number.isFinite(+p.age) && p.age !== '' ? Math.max(0, Math.min(120, +p.age)) : '',
  child: typeof p.child === 'string' ? p.child.slice(0, 5) : '',
  income: typeof p.income === 'string' ? p.income.slice(0, 12) : '',
  house: typeof p.house === 'string' ? p.house.slice(0, 12) : '',
  jobs: Array.isArray(p.jobs) ? p.jobs.filter(j => typeof j === 'string').slice(0, 12) : [],
});

export function createApp({ db, config, gov24Client = null, log = console.log }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const ip = req.socket.remoteAddress || '';
    try {
      if (path.startsWith('/api/')) {
        if (rateLimited(ip)) return send(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
        const q = Object.fromEntries(url.searchParams);
        const m = (method, re) => req.method === method && path.match(re);
        let r;

        // ---------- 공개 API ----------
        if (m('GET', /^\/api\/health$/)) return send(res, 200, { ok: true, time: nowIso(), lastSync: getMeta(db, 'gov24_last_sync') });

        if (m('GET', /^\/api\/programs$/)) {
          const limit = Math.min(+q.limit || 50, 5000), offset = Math.max(+q.offset || 0, 0);
          const out = listPrograms(db, { q: q.q?.slice(0, 50), cat: q.cat, region: q.region, city: q.city, status: q.status, type: q.type, limit, offset });
          return send(res, 200, { ...out, lastSync: getMeta(db, 'gov24_last_sync') });
        }
        if ((r = m('GET', /^\/api\/programs\/([\w-]{1,80})$/))) {
          const p = getProgram(db, r[1]);
          if (!p || (p.hidden && !isAdmin(req, config.adminToken))) return send(res, 404, { error: '사업을 찾을 수 없습니다.' });
          return send(res, 200, { ...p, status: statusOf(p) });
        }
        if (m('POST', /^\/api\/match$/)) {
          const prof = cleanProfile((await readJson(req)).profile);
          const { items } = listPrograms(db, { region: prof.region || undefined, limit: 100000 });
          const groups = { high: [], check: [], no: [] };
          for (const p of items) {
            if (p.status.k === 'closed') continue;
            const ev = evaluate(p, prof);
            groups[ev.m].push({ id: p.id, name: p.name, org: p.org, status: p.status, why: ev.why });
          }
          return send(res, 200, { counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), ...groups });
        }
        if (m('GET', /^\/api\/deadlines$/)) {
          const days = Math.min(+q.days || 14, 60);
          const { items } = listPrograms(db, { status: 'open', limit: 100000 });
          return send(res, 200, { items: items.filter(p => p.status.left != null && p.status.left <= days) });
        }

        // 마감 알림 구독 (기기 임의 ID 기반, 이메일 선택)
        if (m('POST', /^\/api\/subscriptions$/)) {
          const b = await readJson(req);
          const deviceId = String(b.deviceId || '');
          if (!UUID_RE.test(deviceId)) return send(res, 400, { error: 'deviceId 형식 오류' });
          if (!getProgram(db, String(b.programId || ''))) return send(res, 404, { error: '사업 없음' });
          const email = b.email ? String(b.email).trim() : null;
          if (email && !EMAIL_RE.test(email)) return send(res, 400, { error: '이메일 형식 오류' });
          db.prepare(`INSERT INTO subscriptions (device_id, program_id, email, created_at) VALUES (?,?,?,?)
            ON CONFLICT(device_id, program_id) DO UPDATE SET email = excluded.email`).run(deviceId, b.programId, email, nowIso());
          buildNotifications(db);
          return send(res, 201, { ok: true });
        }
        if (m('DELETE', /^\/api\/subscriptions$/)) {
          const b = await readJson(req);
          db.prepare('DELETE FROM subscriptions WHERE device_id = ? AND program_id = ?').run(String(b.deviceId || ''), String(b.programId || ''));
          return send(res, 200, { ok: true });
        }
        if (m('GET', /^\/api\/notifications$/)) {
          if (!UUID_RE.test(q.deviceId || '')) return send(res, 400, { error: 'deviceId 형식 오류' });
          const items = db.prepare('SELECT id, program_id, kind, message, created_at, read_at FROM notifications WHERE device_id = ? ORDER BY created_at DESC LIMIT 50').all(q.deviceId);
          return send(res, 200, { items });
        }
        if (m('POST', /^\/api\/notifications\/read$/)) {
          const b = await readJson(req);
          db.prepare('UPDATE notifications SET read_at = ? WHERE device_id = ? AND read_at IS NULL').run(nowIso(), String(b.deviceId || ''));
          return send(res, 200, { ok: true });
        }

        // ---------- 관리자 API ----------
        if (path.startsWith('/api/admin/')) {
          if (!isAdmin(req, config.adminToken)) return send(res, 401, { error: '관리자 인증 필요' });
          if (m('POST', /^\/api\/admin\/sync$/)) {
            if (!gov24Client) return send(res, 400, { error: 'DATA_GO_KR_KEY가 설정되지 않아 수집할 수 없습니다.' });
            const out = await syncGov24(db, gov24Client, { mode: q.mode === 'full' ? 'full' : 'incremental', log });
            buildNotifications(db);
            return send(res, out.ok ? 200 : 502, out);
          }
          if (m('GET', /^\/api\/admin\/sync-log$/)) return send(res, 200, { items: db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 30').all() });
          if (m('GET', /^\/api\/admin\/stats$/)) {
            const s = db.prepare(`SELECT source, COUNT(*) total, SUM(hidden) hidden, SUM(removed_at IS NOT NULL) removed, SUM(dup_of IS NOT NULL) dups FROM programs GROUP BY source`).all();
            const subs = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
            return send(res, 200, { sources: s, subscriptions: subs, lastSync: getMeta(db, 'gov24_last_sync') });
          }
          if (m('GET', /^\/api\/admin\/programs$/)) {
            const out = listPrograms(db, { q: q.q, includeHidden: true, limit: Math.min(+q.limit || 100, 1000), offset: +q.offset || 0 });
            return send(res, 200, out);
          }
          if ((r = m('PATCH', /^\/api\/admin\/programs\/([\w-]{1,80})$/))) {
            const b = await readJson(req);
            const row = db.prepare('SELECT id FROM programs WHERE id = ?').get(r[1]);
            if (!row) return send(res, 404, { error: '사업 없음' });
            const changes = [];
            if (typeof b.hidden === 'boolean') { db.prepare('UPDATE programs SET hidden = ? WHERE id = ?').run(b.hidden ? 1 : 0, r[1]); changes.push(`hidden=${b.hidden}`); }
            if (['official', 'secondary', 'gov24', 'unverified'].includes(b.verify)) {
              const p = JSON.parse(db.prepare('SELECT data FROM programs WHERE id = ?').get(r[1]).data);
              p.verify = b.verify;
              db.prepare('UPDATE programs SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), nowIso(), r[1]);
              changes.push(`verify=${b.verify}`);
            }
            db.prepare('INSERT INTO program_history (program_id, at, kind, changes) VALUES (?,?,?,?)').run(r[1], nowIso(), 'admin', JSON.stringify(changes));
            return send(res, 200, { ok: true, changes });
          }
          if (m('POST', /^\/api\/admin\/notify-run$/)) {
            const created = buildNotifications(db);
            const mail = await sendEmails(db, config.smtp, { log });
            return send(res, 200, { created, ...mail });
          }
          return send(res, 404, { error: '없는 관리자 API' });
        }
        return send(res, 404, { error: '없는 API' });
      }

      // ---------- 정적 파일 ----------
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '허용되지 않는 요청');
      let file = path === '/' ? '/index.html' : path === '/admin' ? '/admin.html' : path;
      file = normalize(join(PUBLIC, decodeURIComponent(file)));
      if (!file.startsWith(PUBLIC)) return send(res, 403, '금지');
      try {
        const buf = await readFile(file);
        return send(res, 200, buf, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      } catch { return send(res, 404, '페이지를 찾을 수 없습니다'); }
    } catch (err) {
      const code = err.code === 413 || err.code === 400 ? err.code : 500;
      if (code === 500) log('[http] 오류', err);
      return send(res, code, { error: code === 500 ? '서버 오류가 발생했습니다.' : err.message, ref: code === 500 ? randomUUID().slice(0, 8) : undefined });
    }
  };
}
