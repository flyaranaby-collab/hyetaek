// 정부24 API 모의 서버 (실제 응답 형식: { page, perPage, totalCount, currentCount, data: [...] })
import { createServer } from 'node:http';

export function mockGov24({ list, detail, conds, failFirst = 0, key = 'TESTKEY' }) {
  let calls = 0, failures = failFirst;
  const state = { list, detail, conds };
  const server = createServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('serviceKey') !== key) { res.writeHead(401); return res.end('SERVICE_KEY_IS_NOT_REGISTERED_ERROR'); }
    if (failures > 0) { failures--; res.writeHead(503); return res.end('busy'); }
    const page = +u.searchParams.get('page') || 1, per = +u.searchParams.get('perPage') || 10;
    let rows = u.pathname.endsWith('serviceList') ? state.list : u.pathname.endsWith('serviceDetail') ? state.detail : state.conds;
    const since = u.searchParams.get('cond[수정일시::GTE]');
    if (since) rows = rows.filter(r => r['수정일시'] >= since);
    const sid = u.searchParams.get('cond[서비스ID::EQ]');
    if (sid) rows = rows.filter(r => r['서비스ID'] === sid);
    const data = rows.slice((page - 1) * per, page * per);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ page, perPage: per, totalCount: rows.length, currentCount: data.length, data }));
  });
  return new Promise(r => server.listen(0, () => r({ server, state, base: `http://127.0.0.1:${server.address().port}/api`, calls: () => calls })));
}

export const svc = (id, name, extra = {}) => ({
  '서비스ID': id, '서비스명': name, '소관기관명': '보건복지부', '소관기관유형': '중앙행정기관', '부서명': '복지정책과',
  '서비스분야': '생활안정', '지원대상': '저소득 가구', '지원내용': '생활비 지원', '선정기준': '중위소득 50% 이하',
  '신청방법': '방문 신청', '신청기한': '상시신청', '지원유형': '현금지급', '전화문의': '129',
  '상세조회URL': `https://www.gov.kr/portal/rcvfvrSvc/dtlEx/${id}`, '수정일시': '20261101000000', ...extra,
});
