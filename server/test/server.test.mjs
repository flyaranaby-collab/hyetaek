import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, getMeta } from '../src/db.js';
import { Gov24Client, Gov24Error } from '../src/gov24.js';
import { syncGov24 } from '../src/sync.js';
import { loadCurated, getProgram, listPrograms } from '../src/repo.js';
import { createApp } from '../src/app.js';
import { buildNotifications } from '../src/notify.js';
import { normalizeGov24, parsePeriod } from '../src/normalize.js';
import { evaluate, statusOf, toDate } from '../../data/logic.mjs';
import { P as CURATED } from '../../data/catalog.mjs';
import { mockGov24, svc } from './helpers.mjs';

const quiet = () => {};
const today = toDate('2026-11-16');

function fixture() {
  const list = [
    svc('A1', '저소득층 생활안정 지원'),
    svc('A2', '에너지바우처', { '서비스분야': '생활안정', '신청기한': '2026.06.15 ~ 2026.12.31' }), // 큐레이션과 중복
    svc('A3', '강릉시 어업인 안전장비 지원', { '소관기관명': '강원특별자치도 강릉시', '소관기관유형': '지방자치단체', '서비스분야': '농림축산어업', '신청기한': '2026년 11월 20일까지' }),
    svc('A4', '청년 구직 응원금', { '서비스분야': '고용·창업', '신청기한': '예산 소진 시까지' }),
    svc('A5', '어르신 문화 이용권', { '서비스분야': '문화·환경', '신청기한': '2026.01.01~2026.03.31' }),
  ];
  const detail = list.map(r => ({ '서비스ID': r['서비스ID'], '서비스명': r['서비스명'], '구비서류': '○ 신청서\n○ 신분증\n○ 통장 사본', '온라인신청사이트URL': 'https://www.bokjiro.go.kr', '신청기한': r['신청기한'], '수정일시': r['수정일시'] }));
  const conds = [
    { '서비스ID': 'A3', JA0314: 'Y', JA0110: 0, JA0111: 0 },
    { '서비스ID': 'A4', JA0327: 'Y', JA0110: 19, JA0111: 34, JA0201: 'Y', JA0202: 'Y', JA0203: 'Y' },
  ];
  return { list, detail, conds };
}

test('정규화: 기간 해석과 금액 미추측', () => {
  assert.deepEqual(parsePeriod('상시신청'), { type: 'always' });
  assert.equal(parsePeriod('2026년 11월 20일까지').end, '2026-11-20');
  assert.equal(parsePeriod('예산 소진 시까지').type, 'notice');
  const p = normalizeGov24(fixture().list[2], fixture().detail[2], fixture().conds[0]);
  assert.equal(p.region, '강원'); assert.equal(p.city, '강릉시');
  assert.ok(p.cats.includes('fish') && p.cats.includes('local'));
  assert.equal(p.amount, null, '자유 텍스트에서 금액을 만들어내면 안 됨');
  assert.deepEqual(p.docs, ['신청서', '신분증', '통장 사본']);
});

test('API 클라이언트: 일시 오류는 재시도, 인증 오류는 즉시 실패', async () => {
  const m = await mockGov24({ ...fixture(), failFirst: 2 });
  const c = new Gov24Client({ base: m.base, apiKey: 'TESTKEY', perPage: 2, delayMs: 0, retries: 3 });
  const rows = []; for await (const r of c.serviceList()) rows.push(r);
  assert.equal(rows.length, 5, '페이지를 끝까지 넘겨야 함');
  const bad = new Gov24Client({ base: m.base, apiKey: 'WRONG', retries: 3, delayMs: 0 });
  await assert.rejects(() => bad.call('/gov24/v3/serviceList'), e => e instanceof Gov24Error && e.status === 401);
  m.server.closeAllConnections(); m.server.close();
});

test('수집 → 변경 감지 → 종료 처리 → 중복 통합', async () => {
  const db = openDb(':memory:');
  loadCurated(db, CURATED);
  const m = await mockGov24(fixture());
  const c = new Gov24Client({ base: m.base, apiKey: 'TESTKEY', perPage: 2, delayMs: 0 });

  let r = await syncGov24(db, c, { mode: 'full', log: quiet });
  assert.equal(r.ok, true); assert.equal(r.created, 5);
  // 큐레이션 '에너지바우처'와 이름이 같은 정부24 사업은 중복으로 묶임
  assert.equal(getProgram(db, 'gov24-A2').dupOf, 'energy-voucher');
  assert.ok(!listPrograms(db, { limit: 1000, today }).items.some(p => p.id === 'gov24-A2'), '중복 공고는 목록에 한 번만');

  // 내용 변경 → updated + 이력
  m.state.list = m.state.list.map(x => x['서비스ID'] === 'A1' ? { ...x, '지원내용': '생활비 월 지원(변경)', '수정일시': '20261110000000' } : x);
  m.state.detail = m.state.detail.map(x => x['서비스ID'] === 'A1' ? { ...x, '지원내용': '생활비 월 지원(변경)', '수정일시': '20261110000000' } : x);
  r = await syncGov24(db, c, { mode: 'incremental', log: quiet });
  assert.equal(r.mode, 'incremental'); assert.equal(r.updated, 1);
  assert.equal(getProgram(db, 'gov24-A1').history[0].kind, 'updated');
  assert.deepEqual(getProgram(db, 'gov24-A1').history[0].changes, ['content']);

  // 원천에서 사라짐 → 종료(숨김) + 이력
  m.state.list = m.state.list.filter(x => x['서비스ID'] !== 'A5');
  r = await syncGov24(db, c, { mode: 'full', log: quiet });
  assert.equal(r.removed, 1);
  const a5 = getProgram(db, 'gov24-A5');
  assert.ok(a5.removedAt && a5.hidden); assert.equal(a5.history[0].kind, 'removed');

  // 비정상적으로 적은 응답 → 대량 종료 방지
  m.state.list = m.state.list.slice(0, 1);
  r = await syncGov24(db, c, { mode: 'full', log: quiet });
  assert.equal(r.removed, 0);
  m.server.closeAllConnections(); m.server.close();
});

test('API 오류에도 서버 데이터는 유지되고 실패가 기록됨', async () => {
  const db = openDb(':memory:');
  loadCurated(db, CURATED);
  const c = new Gov24Client({ base: 'http://127.0.0.1:9/api', apiKey: 'K', retries: 0, timeoutMs: 500 });
  const r = await syncGov24(db, c, { mode: 'full', log: quiet });
  assert.equal(r.ok, false);
  assert.equal(db.prepare('SELECT ok FROM sync_log ORDER BY id DESC').get().ok, 0);
  assert.ok(listPrograms(db, { limit: 1000 }).total >= CURATED.length - 5, '큐레이션 데이터는 그대로');
});

test('자격 비교: 불명확하면 가능으로 판단하지 않음', () => {
  const rent = CURATED.find(p => p.id === 'youth-rent');
  assert.equal(evaluate(rent, {}).m, 'check');
  assert.equal(evaluate(rent, { age: 25, house: 'rent' }).m, 'check', '소득 기준은 soft → 추가 확인');
  assert.equal(evaluate(rent, { age: 40, house: 'rent' }).m, 'no');
  const gn = CURATED.find(p => p.id === 'gn-livelihood');
  assert.equal(evaluate(gn, { region: '강원', city: '강릉시' }).m, 'high');
  assert.equal(evaluate(gn, { region: '강원', city: '속초시' }).m, 'no');
  assert.equal(evaluate(gn, { region: '서울' }).m, 'no');
  assert.equal(evaluate(gn, {}).m, 'check');
  assert.equal(statusOf(gn, today).k, 'open');
  assert.equal(statusOf(CURATED.find(p => p.id === 'munhwa-nuri'), today).label, 'D-14');
  assert.equal(statusOf(CURATED.find(p => p.id === 'pre-startup-26'), today).k, 'closed');
});

test('HTTP API: 검색·맞춤·구독·알림·관리자 보호·경로 탐색 차단', async () => {
  const db = openDb(':memory:');
  loadCurated(db, CURATED);
  const m = await mockGov24(fixture());
  const client = new Gov24Client({ base: m.base, apiKey: 'TESTKEY', delayMs: 0 });
  const srv = createServer(createApp({ db, config: { adminToken: 'secret-token' }, gov24Client: client, log: quiet }));
  await new Promise(r => srv.listen(0, r));
  const B = `http://127.0.0.1:${srv.address().port}`;
  const j = async (path, opt) => { const r = await fetch(B + path, opt); return { s: r.status, b: await r.json().catch(() => null) }; };

  assert.equal((await j('/api/admin/sync', { method: 'POST' })).s, 401);
  const sync = await j('/api/admin/sync?mode=full', { method: 'POST', headers: { authorization: 'Bearer secret-token' } });
  assert.equal(sync.s, 200); assert.equal(sync.b.created, 5);

  const list = await j('/api/programs?region=' + encodeURIComponent('강원') + '&cat=fish&limit=100');
  assert.ok(list.b.items.some(p => p.id === 'gov24-A3'));
  assert.ok(list.b.items.every(p => p.region === 'all' || p.region === '강원'));
  const open = await j('/api/programs?status=open&limit=1000');
  assert.ok(open.b.items.every(p => p.status.open));

  const match = await j('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: { region: '강원', city: '강릉시', age: 42, jobs: ['fisher'], child: 'none', income: 'mid', house: 'own' } }) });
  assert.ok(match.b.high.some(p => p.id === 'gn-livelihood'));
  assert.ok(match.b.high.some(p => p.id === 'gov24-A3'));
  assert.ok(![...match.b.high, ...match.b.check].some(p => p.status.k === 'closed'), '마감 사업은 추천 제외');

  const dev = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  assert.equal((await j('/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: dev, programId: 'munhwa-nuri', email: 'not-an-email' }) })).s, 400);
  assert.equal((await j('/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: dev, programId: 'munhwa-nuri' }) })).s, 201);
  assert.equal((await j('/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: dev, programId: 'gov24-A3' }) })).s, 201);
  assert.equal(buildNotifications(db, { today: toDate('2026-11-23') }), 1, '문화누리카드 D-7');
  assert.equal(buildNotifications(db, { today: toDate('2026-11-23') }), 0, '같은 알림 중복 생성 안 함');
  assert.equal(buildNotifications(db, { today: toDate('2026-11-19') }), 1, 'A3 마감 D-1');
  const noti = await j('/api/notifications?deviceId=' + dev);
  assert.equal(noti.b.items.length, 2);

  assert.equal((await fetch(B + '/..%2f..%2fpackage.json')).status, 403);
  assert.equal((await j('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).s, 400);
  assert.equal((await j('/api/programs/gov24-A2')).b.dupOf, 'energy-voucher');
  srv.closeAllConnections(); srv.close(); m.server.closeAllConnections(); m.server.close();
});
