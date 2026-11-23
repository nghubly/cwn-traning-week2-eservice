'use strict';
/**
 * B08 · แจ้งเตือน SLA ในกระดิ่ง (BR-14 BR-15 · CONTRACT 0.7 2.1 2.12 6.3 · DECISIONS 8 · TEST-DATA 8)
 *
 * ประเมินทุก request (hooks.onEveryRequest order 20 · หลังยกเลิกอัตโนมัติ order 10/15)
 * app.js ไม่เรียก hook สำหรับ /api/test/* และ /static/* อยู่แล้ว
 *
 * ระดับ = rules.slaLevel (เฉพาะ SUBMITTED IN_REVIEW PENDING_APPROVAL APPROVED · NEED_FIX/ปิดแล้วไม่ประเมิน)
 * ประเมินเฉพาะระดับปัจจุบัน (A-30): ข้ามจากปกติไปเกินกำหนดเลย → ได้ overdue อย่างเดียว ไม่มี near ย้อนหลัง
 *
 * ผู้รับ (A-31):
 *   PENDING_APPROVAL              → head ทุกคน
 *   APPROVED (รอออกเอกสาร)         → ผู้ออกเอกสาร (cases.issuer · ไม่มี → owner → เจ้าหน้าที่แผนก)
 *   มีผู้ถือ (owner)                → ผู้ถือ
 *   ไม่มีผู้ถือ (คิวแผนก cases.dept) → เจ้าหน้าที่ทุกคน (active) ของแผนกนั้น
 *   ระดับ overdue                  → + head ทุกคน (ไม่ซ้ำถ้าเป็นผู้รับอยู่แล้ว)
 * 1 ครั้งต่อ (คำขอ, ระดับ, คน): UNIQUE(username, case_no, level) + INSERT OR IGNORE
 *
 * หน้า/API (ลงทะเบียนใน install หลัง routes ของบล็อกอื่น ก่อน fallback 404):
 *   GET /notifications       officer · head (anon → /login · บทบาทอื่น → 403 forbidden-msg)
 *   GET /api/notifications   officer · head → {items:[{id,caseNo,level,text,createdAt}]} ของผู้ใช้นั้นเท่านั้น
 * bell-count ใน header นับจากตาราง notifications โดย routes/auth.js
 */
const dbm = require('../db');
const clock = require('./clock');
const rules = require('./rules');
const { html } = require('./html');

const LEVEL_TEXT = { near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด' };
const OPEN_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];

function db() {
  return dbm.db;
}

function notiText(caseNo, level) {
  return `คำขอ ${caseNo} ${LEVEL_TEXT[level]}`;
}

function activeStaff(d) {
  const rows = d.prepare("SELECT username, role, dept FROM users WHERE role IN ('officer','head') AND active = 1 AND username IS NOT NULL").all();
  const heads = [];
  const byDept = new Map();
  const known = new Set();
  for (const r of rows) {
    known.add(r.username);
    if (r.role === 'head') heads.push(r.username);
    else {
      if (!byDept.has(r.dept)) byDept.set(r.dept, []);
      byDept.get(r.dept).push(r.username);
    }
  }
  return { heads, byDept, known };
}

/** ผู้รับของคำขอ ณ ระดับนี้ (ไม่ซ้ำ) */
function recipientsFor(c, level, staff) {
  const out = new Set();
  const deptOfficers = (dept) => staff.byDept.get(dept || 'registry') || [];
  if (c.status === 'PENDING_APPROVAL' || (!c.owner && c.dept === 'head')) {
    staff.heads.forEach((u) => out.add(u));
  } else if (c.status === 'APPROVED') {
    const who = c.issuer || c.owner;
    if (who) out.add(who);
    else deptOfficers(c.dept).forEach((u) => out.add(u));
  } else if (c.owner) {
    out.add(c.owner);
  } else {
    deptOfficers(c.dept).forEach((u) => out.add(u));
  }
  if (level === 'overdue') staff.heads.forEach((u) => out.add(u));
  return [...out].filter((u) => staff.known.has(u));
}

/** ประเมินแจ้งเตือนทั้งหมด ณ เวลา now (ค่าเริ่มต้น = นาฬิกาทดสอบ) · คืนจำนวนรายการใหม่ */
function evaluate(now) {
  const d = db();
  const t = now === undefined || now === null ? clock.now() : now;
  const nowIso = clock.toIso(t);
  const cases = d.prepare(
    `SELECT case_no, status, dept, owner, issuer, due_at FROM cases
     WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')}) AND due_at IS NOT NULL`
  ).all(...OPEN_STATUSES);
  if (!cases.length) return 0;
  const hol = rules.loadHolidays(d);
  const staff = activeStaff(d);
  const ins = d.prepare('INSERT OR IGNORE INTO notifications (username, case_no, level, text, created_at) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  d.transaction(() => {
    for (const c of cases) {
      const level = rules.slaLevel({ status: c.status, dueAt: c.due_at }, t, hol);
      if (level !== 'near' && level !== 'overdue') continue;
      const text = notiText(c.case_no, level);
      for (const u of recipientsFor(c, level, staff)) added += ins.run(u, c.case_no, level, text, nowIso).changes;
    }
  })();
  return added;
}

function listFor(username) {
  return db().prepare(
    'SELECT id, case_no, level, text, created_at FROM notifications WHERE username = ? ORDER BY created_at DESC, id DESC'
  ).all(username).map((r) => ({ id: r.id, caseNo: r.case_no, level: r.level, text: r.text, createdAt: r.created_at }));
}

function countFor(username) {
  return db().prepare('SELECT COUNT(*) AS n FROM notifications WHERE username = ?').get(username).n;
}

function renderList(items) {
  if (!items.length) return html`<p data-testid="noti-empty">ไม่มีแจ้งเตือน</p>`;
  return html`<ul class="noti-list">${items.map((n) => html`<li data-testid="noti-item" data-case-no="${n.caseNo}" data-level="${n.level}" class="noti noti-${n.level}">
    <a href="/officer/cases/${encodeURIComponent(n.caseNo)}">${n.text}</a>
    <time datetime="${n.createdAt}" data-iso="${n.createdAt}">${clock.formatThai(n.createdAt)}</time>
  </li>`)}</ul>`;
}

function install(ctx = {}) {
  const hooks = ctx.hooks || require('./hooks');
  hooks.onEveryRequest(() => {
    try { evaluate(); } catch (e) { console.error('[notify] evaluate error:', e.message); }
  }, { order: 20 });

  const app = ctx.app;
  if (!app) return;
  const auth = require('../routes/auth');

  app.get('/notifications', auth.requirePage('officer', 'head'), (req, res) => {
    const items = listFor(req.user.username);
    return auth.sendPage(req, res, {
      title: 'แจ้งเตือน',
      body: html`<h1>แจ้งเตือน</h1>
        <p class="muted">แจ้งเตือนกำหนดเสร็จของคำขอที่อยู่ในความรับผิดชอบ (${items.length} รายการ)</p>
        ${renderList(items)}`,
    });
  });

  app.get('/api/notifications', auth.requireApi('officer', 'head'), (req, res) => {
    res.status(200).json({ items: listFor(req.user.username) });
  });
}

module.exports = { install, evaluate, recipientsFor, listFor, countFor, notiText, LEVEL_TEXT };
