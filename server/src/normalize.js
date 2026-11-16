// 정부24 공공서비스 API 응답 → 앱 공통 사업 형식으로 변환
// 원칙: 지원금액을 추측하지 않는다. 기간을 해석하지 못하면 '공고 확인'으로 둔다.
import { createHash } from 'node:crypto';

const REGION_MAP = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천', '광주광역시': '광주',
  '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종', '경기도': '경기',
  '강원특별자치도': '강원', '강원도': '강원', '충청북도': '충북', '충청남도': '충남',
  '전북특별자치도': '전북', '전라북도': '전북', '전라남도': '전남', '경상북도': '경북', '경상남도': '경남',
  '제주특별자치도': '제주',
};

/** 소관기관명 → {region, city}. 중앙부처·공공기관은 전국 */
export function parseRegion(orgName = '', orgType = '') {
  const parts = String(orgName).trim().split(/\s+/);
  const region = REGION_MAP[parts[0]];
  if (!region) return { region: 'all', city: null };
  const city = parts[1] && /(시|군|구)$/.test(parts[1]) ? parts[1] : null;
  return { region, city };
}

/** 이름 정규화(중복 판별용): 연도·괄호·공백·특수문자 제거 */
export function nameKey(name = '') {
  return String(name)
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/20\d\d\s*년?(도)?/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

const pad = n => String(n).padStart(2, '0');
const DATE_RE = /(20\d\d)\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/g;

/** '신청기한' 자유 텍스트 → period */
export function parsePeriod(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { type: 'notice', note: '신청기한 정보 없음 — 공고 확인' };
  if (/상시|연중|수시/.test(text) && !DATE_RE.test(text)) { DATE_RE.lastIndex = 0; return { type: 'always' }; }
  DATE_RE.lastIndex = 0;
  const dates = [...text.matchAll(DATE_RE)]
    .map(m => `${m[1]}-${pad(m[2])}-${pad(m[3])}`)
    .filter(d => { const [, mm, dd] = d.split('-').map(Number); return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31; });
  if (dates.length >= 2) return { start: dates[0], end: dates[dates.length - 1], raw: text };
  if (dates.length === 1) {
    if (/까지|마감|~\s*20/.test(text)) return { end: dates[0], raw: text };
    if (/부터|~\s*$/.test(text)) return { start: dates[0], raw: text };
  }
  return { type: 'notice', note: text.length > 120 ? text.slice(0, 117) + '…' : text };
}

const FIELD_CATS = [
  [/임신|출산/, 'birth'], [/보육|육아/, 'birth'], [/교육/, 'edu'], [/고용/, 'job'], [/창업/, 'startup'],
  [/주거/, 'house'], [/생활안정|서민|보호|돌봄/, 'lowinc'], [/문화|체육|관광/, 'culture'],
  [/보건|의료/, 'health'], [/농림|축산|농업/, 'farm'], [/환경|에너지/, 'energy'],
];
const TEXT_CATS = [
  [/어업|어촌|수산|귀어|어선/, 'fish'], [/귀농|농업인|영농/, 'farm'], [/청년/, 'youth'],
  [/노인|어르신|기초연금|65세/, 'senior'], [/소상공인|자영업/, 'smb'], [/중소기업/, 'smb'],
  [/장학|학자금/, 'edu'], [/월세|전세|임대주택|주거/, 'house'],
];
export function toCats(field = '', text = '', region = 'all') {
  const set = new Set();
  for (const [re, c] of FIELD_CATS) if (re.test(field)) set.add(c);
  for (const [re, c] of TEXT_CATS) if (re.test(text)) set.add(c);
  if (region !== 'all') set.add('local');
  if (!set.size) set.add('etc');
  return [...set];
}

export function toType(kind = '') {
  if (/현금|급여|수당|장려금/.test(kind)) return '현금';
  if (/이용권|바우처|쿠폰/.test(kind)) return '바우처';
  if (/융자|대출|보증/.test(kind)) return '융자';
  if (/감면|면제|공제/.test(kind)) return '감면';
  if (/현물|물품/.test(kind)) return '현물';
  return kind ? (kind.length <= 6 ? kind : '서비스') : '서비스';
}

const splitDocs = s => String(s ?? '')
  .split(/\r?\n|○|●|■|▶|- (?=\S)|·(?=\s*\S)|,\s(?=\S)/)
  .map(x => x.replace(/^[\s\-*\d.)]+/, '').trim())
  .filter(x => x && x !== '해당없음' && x.length < 120);

const yes = v => v === 'Y' || v === 'y' || v === true || v === 1 || v === '1';

/** supportConditions 코드 → 자격 규칙. 민감·세부 조건은 'soft'로 */
export function conditionsToRules(c) {
  if (!c) return [{ t: 'soft', label: '정부24 상세 자격조건 확인' }];
  const rules = [];
  const a0 = +c.JA0110, a1 = +c.JA0111;
  if ((a0 > 0 || a1 > 0) && !(a0 === 0 && a1 >= 100)) rules.push({ t: 'age', min: a0 > 0 ? a0 : 0, max: a1 > 0 ? a1 : 120 });

  // 소득(중위소득 %): 0-50 → 수급·차상위, 51-100 → 중위 100% 이하, 100 초과 → high
  const inc = { r: yes(c.JA0201), m: yes(c.JA0202) || yes(c.JA0203), h: yes(c.JA0204) || yes(c.JA0205) };
  if ((inc.r || inc.m || inc.h) && !(inc.r && inc.m && inc.h)) {
    const allow = [];
    if (inc.r) allow.push('recipient', 'nearpoor');
    if (inc.m) allow.push('recipient', 'nearpoor', 'mid');
    if (inc.h) allow.push('high');
    rules.push({ t: 'income', in: [...new Set(allow)] });
    if (inc.m && !yes(c.JA0202) !== !yes(c.JA0203)) rules.push({ t: 'soft', label: '정확한 중위소득 구간 확인' });
  }

  const jobs = [];
  if (yes(c.JA0326)) jobs.push('worker');
  if (yes(c.JA0327)) jobs.push('jobseeker');
  if (yes(c.JA1101)) jobs.push('prestart');
  if (yes(c.JA1102) || yes(c.JA1103)) jobs.push('self');
  if (yes(c.JA0313) || yes(c.JA0315) || yes(c.JA0316)) jobs.push('farmer');
  if (yes(c.JA0314)) jobs.push('fisher', 'fishhope');
  if (yes(c.JA0320)) jobs.push('student');
  if (jobs.length) rules.push({ t: 'job', in: [...new Set(jobs)] });

  if (yes(c.JA0303)) rules.push({ t: 'child', max: 0 });
  if (yes(c.JA0412)) rules.push({ t: 'house', in: ['rent', 'jeonse', 'family'] });

  const SOFT = {
    JA0301: '예비부모·난임 가구', JA0302: '임산부', JA0401: '다문화가족', JA0402: '북한이탈주민',
    JA0403: '한부모·조손가정', JA0404: '1인 가구', JA0411: '다자녀가구', JA0413: '신규 전입',
    JA0328: '장애인', JA0329: '국가보훈대상자', JA0330: '질병·질환자',
    JA0317: '초등학생', JA0318: '중학생', JA0319: '고등학생',
    JA2101: '중소기업', JA2102: '사회복지시설', JA2103: '기관·단체',
  };
  const softs = Object.entries(SOFT).filter(([k]) => yes(c[k])).map(([, v]) => v);
  if (softs.length) rules.push({ t: 'soft', label: `대상 해당 여부 확인: ${softs.join('·')}` });
  return rules;
}

export function hashOf(obj) {
  return createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

/**
 * @param list  serviceList 행
 * @param detail serviceDetail 행 (없을 수 있음)
 * @param cond   supportConditions 행 (없을 수 있음)
 */
export function normalizeGov24(list, detail = {}, cond = null) {
  const d = detail || {};
  const sid = String(list['서비스ID'] ?? d['서비스ID']);
  const name = (list['서비스명'] || d['서비스명'] || '').trim();
  const org = [list['소관기관명'] || d['소관기관명'], list['부서명']].filter(Boolean).join(' ');
  const { region, city } = parseRegion(list['소관기관명'] || d['소관기관명'], list['소관기관유형']);
  const target = d['지원대상'] || list['지원대상'] || '';
  const content = d['지원내용'] || list['지원내용'] || list['서비스목적요약'] || '';
  const rules = conditionsToRules(cond);
  if (city) rules.push({ t: 'city', city });

  return {
    id: `gov24-${sid}`,
    source: 'gov24',
    sourceId: sid,
    name,
    org: org || '정보 없음',
    cats: toCats(list['서비스분야'] || '', `${name} ${target} ${content}`, region),
    region, city,
    type: toType(d['지원유형'] || list['지원유형']),
    target: target.trim(),
    content: content.trim(),
    amount: null, // 자유 텍스트에서 금액을 추측하지 않음 — 지원내용 원문 참고
    amountNote: '지원 내용 원문 참고 (정부24)',
    income: (d['선정기준'] || list['선정기준'] || '공고 확인').trim(),
    period: parsePeriod(d['신청기한'] || list['신청기한']),
    how: (d['신청방법'] || list['신청방법'] || '').trim(),
    docs: splitDocs(d['구비서류']).slice(0, 15),
    url: d['온라인신청사이트URL'] || list['상세조회URL'] || `https://www.gov.kr/portal/rcvfvrSvc/dtlEx/${sid}`,
    detailUrl: list['상세조회URL'] || null,
    contact: (list['전화문의'] || d['문의처'] || list['접수기관'] || d['접수기관명'] || '').trim(),
    verify: 'gov24',
    source_label: `정부24 공공서비스 API (서비스ID ${sid})`,
    sourceUpdatedAt: list['수정일시'] || d['수정일시'] || null,
    rules,
  };
}
