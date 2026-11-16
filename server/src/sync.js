// 정부24 공공서비스 수집 파이프라인: 목록 → 상세 → 자격조건 → 정규화 → upsert → 종료 처리 → 중복 통합
import { nowIso, getMeta, setMeta, tx } from './db.js';
import { normalizeGov24 } from './normalize.js';
import { upsertProgram, markRemoved, dedupe } from './repo.js';

let running = false;

/**
 * @param mode 'full' | 'incremental'
 *   full: 전체를 받아 원천에서 사라진 사업을 '종료'로 표시
 *   incremental: 마지막 수집 이후 수정된 목록만 반영(종료 판정 안 함)
 */
export async function syncGov24(db, client, { mode = 'incremental', log = console.log } = {}) {
  if (running) throw new Error('이미 수집이 진행 중입니다.');
  running = true;
  const startedAt = nowIso();
  const logId = db.prepare('INSERT INTO sync_log (started_at, mode) VALUES (?, ?)').run(startedAt, mode).lastInsertRowid;
  const stat = { fetched: 0, created: 0, updated: 0, removed: 0 };
  try {
    // 증분 기준: 지난 수집에서 본 원천 '수정일시'의 최댓값 (서버 시계와 무관하게 정확)
    const since = mode === 'incremental' ? getMeta(db, 'gov24_max_modified') : null;
    const effMode = since ? 'incremental' : 'full';
    const sinceParam = since || undefined;

    log(`[sync] 목록 수집 (${effMode}${since ? ' since ' + since : ''})`);
    const list = [];
    for await (const row of client.serviceList({ modifiedSince: sinceParam })) list.push(row);
    stat.fetched = list.length;
    const maxMod = list.reduce((m, r) => { const v = String(r['수정일시'] ?? '').replace(/\D/g, '').slice(0, 14); return v > m ? v : m; }, since || '');

    log(`[sync] 상세 수집`);
    const details = new Map();
    for await (const row of client.serviceDetail()) details.set(String(row['서비스ID']), row);

    log(`[sync] 자격조건 수집`);
    const conds = new Map();
    try { for await (const row of client.supportConditions ? client.supportConditionsAll() : []) conds.set(String(row['서비스ID']), row); }
    catch (err) { log(`[sync] 자격조건 일괄 수집 실패 — 조건 없이 진행: ${err.message}`); }

    tx(db, () => {
      const seen = new Set();
      for (const row of list) {
        const sid = String(row['서비스ID'] ?? '');
        if (!sid || !row['서비스명']) continue;
        const p = normalizeGov24(row, details.get(sid), conds.get(sid));
        seen.add(p.id);
        const r = upsertProgram(db, p, { source: 'gov24' });
        if (r !== 'same') stat[r]++;
      }
      if (effMode === 'full' && seen.size > 0) {
        // 안전장치: 응답이 비정상적으로 적으면(기존의 80% 미만) 대량 종료 처리하지 않음
        const active = db.prepare("SELECT COUNT(*) n FROM programs WHERE source='gov24' AND removed_at IS NULL").get().n;
        if (seen.size >= active * 0.8) stat.removed = markRemoved(db, 'gov24', seen);
        else log(`[sync] 수집 건수(${seen.size})가 기존(${active})보다 크게 적어 종료 처리를 건너뜀`);
      }
      dedupe(db);
    });

    setMeta(db, 'gov24_last_sync', startedAt);
    if (maxMod) setMeta(db, 'gov24_max_modified', maxMod);
    db.prepare('UPDATE sync_log SET finished_at=?, ok=1, mode=?, fetched=?, created=?, updated=?, removed=? WHERE id=?')
      .run(nowIso(), effMode, stat.fetched, stat.created, stat.updated, stat.removed, logId);
    log(`[sync] 완료`, stat);
    return { ok: true, mode: effMode, ...stat };
  } catch (err) {
    db.prepare('UPDATE sync_log SET finished_at=?, ok=0, error=? WHERE id=?').run(nowIso(), String(err.message).slice(0, 500), logId);
    log(`[sync] 실패: ${err.message}`);
    return { ok: false, error: err.message, ...stat };
  } finally {
    running = false;
  }
}
