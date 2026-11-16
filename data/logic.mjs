// 상태 계산·자격 비교 로직 — 웹앱과 서버가 함께 사용 (순수 함수)
import { JOBS } from './catalog.mjs';

export const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const fmtDate = s => { const [y, m, d] = s.split('-'); return `${y}.${+m}.${+d}`; };
export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** 신청 상태: always | open | soon | plan | notice | closed */
export function statusOf(p, today = startOfDay()) {
  const pr = p.period || { type: 'notice' };
  if (pr.type === 'always') return { k: 'always', label: '상시 신청', open: true };
  if (pr.type === 'notice') return { k: 'notice', label: '공고 확인', open: false };
  if (pr.type === 'plan') return { k: 'plan', label: '시작 예정', open: false };
  if (pr.type === 'closed') return { k: 'closed', label: '마감', open: false };
  const s = pr.start ? toDate(pr.start) : null, e = pr.end ? toDate(pr.end) : null;
  if (s && today < s) return { k: 'plan', label: '시작 예정', open: false };
  if (!e) return { k: 'open', label: '모집 중', open: true };
  if (today > e) return { k: 'closed', label: '마감', open: false };
  const left = Math.round((e - today) / 86400000);
  if (left <= 14) return { k: 'soon', label: left === 0 ? '오늘 마감' : `D-${left}`, open: true, left };
  return { k: 'open', label: '모집 중', open: true, left };
}

export function periodText(p) {
  const pr = p.period || {};
  if (pr.type === 'always') return '상시 (연중 신청)';
  if (pr.note) return pr.note;
  if (pr.raw) return pr.raw;
  if (pr.start && pr.end) return `${fmtDate(pr.start)} ~ ${fmtDate(pr.end)}`;
  if (pr.end) return `~ ${fmtDate(pr.end)}`;
  return '공고 확인';
}

const CHILD_BUCKET = { '0': [0, 0], '1': [1, 1], '2': [2, 5], '6': [6, 8], '9': [9, 17], '18': [18, 99] };
const jobName = j => (JOBS.find(x => x.id === j) || {}).name || j;

/**
 * 자격 비교. 불명확하면 절대 'high'로 판단하지 않는다.
 * @returns {{m:'high'|'check'|'no', why:string[]}}
 */
export function evaluate(p, prof = {}) {
  const unknown = [], fails = [], soft = [];
  const region = p.region || 'all';
  if (region !== 'all') {
    if (!prof.region) unknown.push('거주 지역 미입력');
    else if (prof.region !== region) fails.push(`${region} 거주자 대상`);
  }
  for (const r of p.rules || []) {
    if (r.t === 'age') {
      if (prof.age === '' || prof.age == null) unknown.push('나이 미입력');
      else if (+prof.age < r.min || +prof.age > r.max) fails.push(`연령 ${r.min}~${r.max}세 대상`);
    } else if (r.t === 'child') {
      if (!prof.child) unknown.push('자녀 정보 미입력');
      else if (prof.child === 'none') fails.push('대상 자녀 없음');
      else {
        const [lo, hi] = CHILD_BUCKET[prof.child] || [0, 99];
        if (lo > r.max) fails.push(`만 ${r.max}세 이하 자녀 대상`);
        else if (hi > r.max) unknown.push('자녀 나이 구간 경계 — 정확한 나이 확인');
      }
    } else if (r.t === 'income') {
      if (!prof.income) unknown.push('소득 구간 미입력');
      else if (!r.in.includes(prof.income)) fails.push('소득 기준 미해당');
    } else if (r.t === 'job') {
      if (!prof.jobs || !prof.jobs.length) unknown.push('하는 일 미입력');
      else if (!r.in.some(j => prof.jobs.includes(j))) fails.push(r.in.map(jobName).join('·') + ' 대상');
    } else if (r.t === 'house') {
      if (!prof.house) unknown.push('주거 형태 미입력');
      else if (!r.in.includes(prof.house)) fails.push('무주택 월세 거주자 대상');
    } else if (r.t === 'region') {
      // 지역 조건은 위에서 p.region으로 처리
    } else if (r.t === 'city') {
      if (prof.region && prof.region !== region) { /* 지역 불일치는 위에서 처리 */ }
      else if (!prof.city) unknown.push('시·군 미입력');
      else if (prof.city !== r.city) fails.push(`${r.city} 거주자 대상`);
    } else if (r.t === 'soft') {
      soft.push(r.label);
    }
  }
  if (fails.length) return { m: 'no', why: [...new Set(fails)] };
  if (unknown.length || soft.length) return { m: 'check', why: [...new Set([...unknown, ...soft])] };
  return { m: 'high', why: ['입력한 조건이 기본 자격과 일치'] };
}
