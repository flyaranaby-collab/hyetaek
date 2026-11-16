// 정적 데이터 내보내기: 휴대폰 앱(GitHub Pages)이 서버 없이 읽는 JSON 파일 생성
//  - index.json : 목록·검색·자격 비교에 필요한 가벼운 정보 (전체)
//  - d/XX.json  : 상세 정보 (지원 대상·내용·서류 등). 사업을 열 때만 내려받음
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { listPrograms } from './repo.js';
import { getMeta } from './db.js';
import { shardOf, SHARDS } from '../../data/shard.mjs';

const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const SLIM = ['id', 'name', 'org', 'cats', 'region', 'city', 'type', 'amount', 'amountNote', 'period', 'rules', 'verify', 'firstSeen', 'lastChecked'];
const DETAIL = ['target', 'content', 'income', 'how', 'docs', 'url', 'contact', 'source'];

export function exportStatic(db, outDir) {
  const { items } = listPrograms(db, { limit: 1e9 });
  rmSync(join(outDir, 'd'), { recursive: true, force: true });
  mkdirSync(join(outDir, 'd'), { recursive: true });
  const shards = Array.from({ length: SHARDS }, () => ({}));
  const index = items.map(p => {
    const o = {};
    for (const k of SLIM) if (p[k] != null && p[k] !== '') o[k] = p[k];
    // 검색용 짧은 요약 (상세 전문은 d/ 파일)
    o.t = cut(p.target, 90); o.c = cut(p.content, 90);
    const d = {};
    for (const k of DETAIL) if (p[k] != null) d[k] = p[k];
    shards[parseInt(shardOf(p.id), 16)][p.id] = d;
    return o;
  });
  const meta = { generated: new Date().toISOString(), lastSync: getMeta(db, 'gov24_last_sync') || null, count: index.length };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify({ ...meta, items: index }));
  shards.forEach((s, i) => writeFileSync(join(outDir, 'd', i.toString(16).padStart(2, '0') + '.json'), JSON.stringify(s)));
  return meta;
}
