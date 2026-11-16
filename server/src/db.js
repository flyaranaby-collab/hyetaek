import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 지원사업 (큐레이션 + 정부24 수집 통합)
CREATE TABLE IF NOT EXISTS programs (
  id          TEXT PRIMARY KEY,           -- curated: 'parent-pay' / gov24: 'gov24-<서비스ID>'
  source      TEXT NOT NULL,              -- 'curated' | 'gov24'
  source_id   TEXT,                       -- 원천 서비스ID
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,              -- 중복 판별용 정규화 이름
  org         TEXT,
  region      TEXT NOT NULL DEFAULT 'all',
  city        TEXT,
  data        TEXT NOT NULL,              -- 화면용 JSON (cats, period, rules ...)
  hash        TEXT NOT NULL,              -- 내용 해시 (변경 감지)
  dup_of      TEXT,                       -- 중복이면 대표 사업 id
  hidden      INTEGER NOT NULL DEFAULT 0, -- 관리자 숨김 / 원천에서 삭제됨
  removed_at  TEXT,
  source_updated_at TEXT,                 -- 원천 수정일시
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_programs_key ON programs(name_key);
CREATE INDEX IF NOT EXISTS ix_programs_region ON programs(region, city);

-- 변경·종료 이력
CREATE TABLE IF NOT EXISTS program_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- created | updated | removed | restored | admin
  changes TEXT                 -- 바뀐 필드 목록(JSON)
);
CREATE INDEX IF NOT EXISTS ix_hist_prog ON program_history(program_id, at);

-- 수집 실행 기록
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL,
  ok INTEGER,
  fetched INTEGER DEFAULT 0, created INTEGER DEFAULT 0, updated INTEGER DEFAULT 0, removed INTEGER DEFAULT 0,
  error TEXT
);

-- 마감 알림 구독 (개인정보 최소화: 기기 임의 ID, 이메일은 선택)
CREATE TABLE IF NOT EXISTS subscriptions (
  device_id  TEXT NOT NULL,
  program_id TEXT NOT NULL,
  email      TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, program_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- d7 | d3 | d1 | d0 | changed | closed
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  emailed_at TEXT,
  UNIQUE (device_id, program_id, kind)
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

export function getMeta(db, k) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : null;
}
export function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

/** 트랜잭션 헬퍼 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}
