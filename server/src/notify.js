// 마감 알림: 관심 등록(구독)한 사업의 마감 D-7·D-3·D-1·당일, 사업 종료를 알림함에 기록하고 (설정 시) 이메일 발송
import { nowIso } from './db.js';
import { statusOf, startOfDay, fmtDate } from '../../data/logic.mjs';

const STEPS = [[7, 'd7'], [3, 'd3'], [1, 'd1'], [0, 'd0']];

export function buildNotifications(db, { today = startOfDay() } = {}) {
  const subs = db.prepare(`SELECT s.device_id, s.program_id, s.email, p.data, p.removed_at
    FROM subscriptions s JOIN programs p ON p.id = s.program_id`).all();
  const ins = db.prepare('INSERT OR IGNORE INTO notifications (device_id, program_id, kind, message, created_at) VALUES (?,?,?,?,?)');
  let created = 0;
  for (const s of subs) {
    const p = JSON.parse(s.data);
    let kind = null, msg = null;
    if (s.removed_at) { kind = 'closed'; msg = `「${p.name}」 사업이 원천 목록에서 종료되었어요.`; }
    else {
      const st = statusOf(p, today);
      if (st.left != null) {
        const step = STEPS.find(([d]) => st.left === d);
        if (step) {
          kind = step[1];
          msg = st.left === 0 ? `「${p.name}」 오늘 신청 마감이에요.` : `「${p.name}」 신청 마감 ${st.left}일 전이에요 (마감 ${fmtDate(p.period.end)}).`;
        }
      }
    }
    if (kind && ins.run(s.device_id, s.program_id, kind, msg, nowIso()).changes) created++;
  }
  return created;
}

/** 아직 메일을 보내지 않은 알림을 이메일로 발송. SMTP 미설정이면 건너뜀 */
export async function sendEmails(db, smtp, { log = console.log } = {}) {
  if (!smtp?.host) return { sent: 0, skipped: 'SMTP 미설정' };
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; }
  catch { log('[notify] nodemailer 미설치 — npm install nodemailer 후 사용'); return { sent: 0, skipped: 'nodemailer 없음' }; }
  const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.port === 465, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined });
  const rows = db.prepare(`SELECT n.id, n.message, n.program_id, s.email FROM notifications n
    JOIN subscriptions s ON s.device_id = n.device_id AND s.program_id = n.program_id
    WHERE n.emailed_at IS NULL AND s.email IS NOT NULL AND s.email != ''`).all();
  let sent = 0;
  for (const r of rows) {
    try {
      await transport.sendMail({ from: smtp.from || smtp.user, to: r.email, subject: `[혜택찾기] ${r.message.slice(0, 60)}`, text: `${r.message}\n\n공식 공고에서 신청 기간과 자격을 꼭 확인하세요.` });
      db.prepare('UPDATE notifications SET emailed_at = ? WHERE id = ?').run(nowIso(), r.id);
      sent++;
    } catch (err) { log(`[notify] 메일 실패(${r.id}): ${err.message}`); }
  }
  return { sent };
}
