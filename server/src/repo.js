// 사업 저장소: upsert·이력·중복 통합·조회
import { nowIso, tx } from './db.js';
import { nameKey, hashOf } from './normalize.js';
import { statusOf, startOfDay } from '../../data/logic.mjs';

const CONTENT_FIELDS = ['name', 'org', 'target', 'content', 'amount', 'income', 'period', 'how', 'docs', 'url', 'contact', 'rules', 'region', 'city', 'type'];
const contentOf = p => Object.fromEntries(CONTENT_FIELDS.map(k => [k, p[k] ?? null]));

/** 사업 1건 upsert. 반환: 'created' | 'updated' | 'same' */
export function upsertProgram(db, p, { source }) {
  const now = nowIso();
  const content = contentOf(p);
  const hash = hashOf(content);
  const row = db.prepare('SELECT id, hash, data, hidden, removed_at FROM programs WHERE id = ?').get(p.id);
  const data = JSON.stringify(p);
  if (!row) {
    db.prepare(`INSERT INTO programs (id, source, source_id, name, name_key, org, region, city, data, hash, source_updated_at, first_seen, last_seen, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id, source, p.sourceId ?? null, p.name, nameKey(p.name), p.org ?? '', p.region || 'all', p.city ?? null, data, hash, p.sourceUpdatedAt ?? null, now, now, now);
    db.prepare('INSERT INTO program_history (program_id, at, kind) VALUES (?,?,?)').run(p.id, now, 'created');
    return 'created';
  }
  const restored = !!row.removed_at;
  db.prepare('UPDATE programs SET last_seen = ?, removed_at = NULL, hidden = CASE WHEN removed_at IS NOT NULL THEN 0 ELSE hidden END WHERE id = ?').run(now, p.id);
  if (restored) db.prepare('INSERT INTO program_history (program_id, at, kind) VALUES (?,?,?)').run(p.id, now, 'restored');
  if (row.hash === hash) return restored ? 'updated' : 'same';
  const old = contentOf(JSON.parse(row.data));
  const changed = CONTENT_FIELDS.filter(k => JSON.stringify(old[k]) !== JSON.stringify(content[k]));
  db.prepare('UPDATE programs SET name=?, name_key=?, org=?, region=?, city=?, data=?, hash=?, source_updated_at=?, updated_at=? WHERE id=?')
    .run(p.name, nameKey(p.name), p.org ?? '', p.region || 'all', p.city ?? null, data, hash, p.sourceUpdatedAt ?? null, now, p.id);
  db.prepare('INSERT INTO program_history (program_id, at, kind, changes) VALUES (?,?,?,?)').run(p.id, now, 'updated', JSON.stringify(changed));
  return 'updated';
}

/** 전체 수집에서 보이지 않은 사업 → 종료(삭제) 처리. 데이터는 지우지 않고 이력 남김 */
export function markRemoved(db, source, seenIds) {
  const now = nowIso();
  const rows = db.prepare('SELECT id FROM programs WHERE source = ? AND removed_at IS NULL').all(source);
  let n = 0;
  for (const { id } of rows) {
    if (seenIds.has(id)) continue;
    db.prepare('UPDATE programs SET removed_at = ?, hidden = 1 WHERE id = ?').run(now, id);
    db.prepare('INSERT INTO program_history (program_id, at, kind) VALUES (?,?,?)').run(id, now, 'removed');
    n++;
  }
  return n;
}

/**
 * 중복 공고 통합: 이름 키가 같으면 하나로 묶는다.
 * 대표 우선순위: curated(사람이 검증) > gov24 최신 수정본. 같은 이름이라도 지역이 다르면 별개 사업.
 */
export function dedupe(db) {
  db.exec('UPDATE programs SET dup_of = NULL');
  const rows = db.prepare(`SELECT id, source, name_key, region, IFNULL(city,'') city, source_updated_at FROM programs
    WHERE removed_at IS NULL ORDER BY name_key, region, city, CASE source WHEN 'curated' THEN 0 ELSE 1 END, source_updated_at DESC`).all();
  let lead = null, n = 0;
  const set = db.prepare('UPDATE programs SET dup_of = ? WHERE id = ?');
  for (const r of rows) {
    const key = `${r.name_key}|${r.region}|${r.city}`;
    if (!r.name_key || r.name_key.length < 3) { lead = null; continue; }
    if (lead && lead.key === key) { set.run(lead.id, r.id); n++; }
    else lead = { key, id: r.id };
  }
  return n;
}

export function loadCurated(db, list) {
  return tx(db, () => {
    const out = { created: 0, updated: 0 };
    for (const p of list) {
      const r = upsertProgram(db, { ...p, sourceId: p.id }, { source: 'curated' });
      if (r !== 'same') out[r]++;
    }
    markRemoved(db, 'curated', new Set(list.map(p => p.id)));
    return out;
  });
}

const toItem = r => {
  const p = JSON.parse(r.data);
  p.lastChecked = (r.source_updated_at || r.updated_at || '').slice(0, 10);
  p.firstSeen = (r.first_seen || '').slice(0, 10);
  if (r.dup_of) p.dupOf = r.dup_of;
  return p;
};

/** 목록 조회 (텍스트·지역은 SQL, 상태·분야는 계산 후 필터) */
export function listPrograms(db, { q, cat, region, city, status, type, includeHidden = false, includeRemoved = false, limit = 50, offset = 0, today = startOfDay() } = {}) {
  const where = ['dup_of IS NULL'], args = [];
  if (!includeHidden) where.push('hidden = 0');
  if (!includeRemoved) where.push('removed_at IS NULL'); // 원천에서 사라진(종료) 사업은 기본 제외
  if (q) { where.push('(name LIKE ? OR org LIKE ? OR data LIKE ?)'); const like = `%${q}%`; args.push(like, like, like); }
  if (region) { where.push("(region = 'all' OR region = ?)"); args.push(region); }
  if (city) { where.push('(city IS NULL OR city = ?)'); args.push(city); }
  let items = db.prepare(`SELECT * FROM programs WHERE ${where.join(' AND ')}`).all(...args).map(toItem);
  if (cat) items = items.filter(p => (p.cats || []).includes(cat));
  if (type) items = items.filter(p => p.type === type);
  const ORDER = { soon: 0, open: 1, always: 2, plan: 3, notice: 4, closed: 5 };
  const withSt = items.map(p => ({ p, s: statusOf(p, today) }));
  let filtered = withSt;
  if (status === 'open') filtered = withSt.filter(x => x.s.open);
  else if (status) filtered = withSt.filter(x => x.s.k === status);
  filtered.sort((a, b) => ORDER[a.s.k] - ORDER[b.s.k] || (a.s.left ?? 9999) - (b.s.left ?? 9999) || a.p.name.localeCompare(b.p.name, 'ko'));
  const total = filtered.length;
  return { total, items: filtered.slice(offset, offset + limit).map(x => ({ ...x.p, status: x.s })) };
}

export function getProgram(db, id) {
  const r = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  if (!r) return null;
  const item = toItem(r);
  item.hidden = !!r.hidden;
  item.removedAt = r.removed_at;
  item.history = db.prepare('SELECT at, kind, changes FROM program_history WHERE program_id = ? ORDER BY at DESC LIMIT 30').all(id)
    .map(h => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null }));
  item.duplicates = db.prepare('SELECT id, source, name FROM programs WHERE dup_of = ?').all(id);
  return item;
}
