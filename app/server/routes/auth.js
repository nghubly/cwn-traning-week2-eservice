'use strict';
/**
 * B03 · ล็อกอิน ThaiD จำลอง / SSO เจ้าหน้าที่จำลอง + ลงทะเบียน + RBAC + layout ตามบทบาท
 * REQUIREMENTS FR-01..03 · BR-01..03 · BR-21 · CONTRACT §1 §2.1–2.3 §5 §6.1 · DECISIONS §1 §2
 *
 * ───────────── ส่วนที่บล็อกอื่นเรียกใช้ ─────────────
 *   const auth = require('./auth');                 // จากไฟล์ใน server/routes/
 *
 *   // หน้า HTML: ไม่ล็อกอิน → 302 /login · citizen ที่ยังไม่ลงทะเบียน → 302 /register · บทบาทไม่ตรง → 403 forbidden-msg
 *   app.get('/officer/queue', auth.requirePage('officer', 'head'), handler);
 *   // API: ไม่ล็อกอิน → 401 UNAUTHENTICATED · บทบาทไม่ตรง → 403 FORBIDDEN  (ไม่ใส่บทบาท = แค่ต้องล็อกอิน)
 *   app.get('/api/officer/queue', auth.requireApi('officer', 'head'), handler);
 *
 *   auth.sendPage(req, res, { title, body, error, success, status })   // layout เต็ม (header + nav ตามบทบาท)
 *   auth.renderPage(req, { title, body, error, success })              // คืนสตริง HTML
 *     body = ผลของ html`...` (lib/html.js) หรือสตริง HTML ที่ escape แล้ว
 *     error   → <div data-testid="action-error" role="alert">   success → <div data-testid="action-success" role="status">
 *   auth.forbiddenPage(req, res)    // 403 + forbidden-msg "ไม่มีสิทธิ์เข้าถึงหน้านี้"
 *   auth.notFoundPage(req, res)     // 404 + not-found-msg "ไม่พบคำขอ" (ใช้ทั้งเลขไม่มีจริงและของคนอื่น)
 *   auth.apiError(res, status, code, message, extra?)   // {"code","message",...extra}
 *   auth.audit({ username, role, event, caseNo, fromStatus, toStatus, detail })  // แถว audit_log (เวลาจากนาฬิกาทดสอบ)
 *   auth.auditFor(req.user, event, {...})                // เหมือน audit แต่ดึง username/role จากผู้ใช้
 *   auth.validIdNo('1101700123456') → true             // BR-01
 *   auth.MSG.FORBIDDEN … ข้อความ error ตรงตัวอักษร (CONTRACT 5)
 */
const express = require('express');
const { db } = require('../db');
const clock = require('../lib/clock');
const pii = require('../lib/pii');
const password = require('../lib/password');
const session = require('../lib/session');
const format = require('../lib/format');
const { html, raw, esc, render } = require('../lib/html');

const OTP_CODE = '123456';            // ⚠️A-05
const OTP_MAX_FAIL = 3;               // ⚠️A-06
const LOCK_MS = 15 * 60 * 1000;       // 15:00 นาที นับจากครั้งที่ 3
const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];

const MSG = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  INVALID_EMAIL: 'รูปแบบอีเมลไม่ถูกต้อง',
  ALREADY_REGISTERED: 'ลงทะเบียนแล้ว',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
  NOT_FOUND: 'ไม่พบคำขอ',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
};

// ───────────────────────── ตัวช่วยทั่วไป ─────────────────────────

/** BR-01: ตัวเลข 13 หลักพอดี + หลักที่ 13 = (11 − (Σ dᵢ×(13−i)) mod 11) mod 10 */
function validIdNo(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  const s = String(v);
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}

/** BR-03: เบอร์มือถือ 10 หลักขึ้นต้น 0 */
function validMobile(v) {
  return (typeof v === 'string' || typeof v === 'number') && /^0\d{9}$/.test(String(v).trim());
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isConsent(v) {
  return v === true || v === 'true' || v === 'on' || v === '1' || v === 1 || v === 'yes';
}

function apiError(res, status, code, message, extra) {
  return res.status(status).json({ code, message, ...(extra || {}) });
}

function audit({ username = null, role = null, event, caseNo = null, fromStatus = null, toStatus = null, detail = '' }) {
  db.prepare(
    'INSERT INTO audit_log(time, username, role, event, case_no, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(clock.nowIso(), username, role, event, caseNo, fromStatus, toStatus, detail == null ? '' : String(detail));
}

function auditFor(user, event, rest = {}) {
  return audit({ username: user ? user.username : null, role: user ? user.role : null, event, ...rest });
}

function needsRegister(req) {
  return !!(req.user && req.user.role === 'citizen' && (!req.user.registered || (req.session && req.session.scope === 'register')));
}

function landingFor(user) {
  if (!user) return '/login';
  if (user.role === 'citizen' && !user.registered) return '/register';
  return format.LANDING[user.role] || '/login';
}

// ───────────────────────── layout + nav ตามบทบาท ─────────────────────────

const NAV = [
  { id: 'nav-my-cases', href: '/citizen', label: 'คำขอของฉัน', roles: ['citizen'] },
  { id: 'nav-queue', href: '/officer/queue', label: 'คิวงาน', roles: ['officer', 'head'] },
  { id: 'nav-approvals', href: '/head/approvals', label: 'รออนุมัติ', roles: ['head'] },
  { id: 'nav-dashboard', href: '/dashboard', label: 'Dashboard', roles: ['executive'] },
  { id: 'nav-audit', href: '/audit', label: 'Audit Trail', roles: ['auditor'] },
  { id: 'nav-admin-services', href: '/admin/services', label: 'บริการ', roles: ['admin'] },
  { id: 'nav-admin-holidays', href: '/admin/holidays', label: 'วันหยุด', roles: ['admin'] },
  { id: 'nav-admin-users', href: '/admin/users', label: 'ผู้ใช้', roles: ['admin'] },
];

function bellCount(user) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE username = ?').get(user.username).n;
  } catch {
    return 0;
  }
}

const STYLE = `
.app-header{background:#0b3d75;color:#fff;padding:.5rem 1rem;display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between}
.app-header a{color:#fff}
.app-header .brand{font-weight:700;margin:0;font-size:1.1rem}
.app-header nav ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.25rem .75rem}
.app-header nav a{display:inline-block;padding:.25rem .25rem;text-decoration:underline}
.app-header nav a[aria-current=page]{font-weight:700}
.app-header .who{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.app-header .who form{margin:0}
.app-header .logout{background:#fff;color:#0b3d75;border-color:#fff}
.app-header .bell-count{display:inline-block;min-width:1.5em;padding:0 .35em;border-radius:1em;background:#fff;color:#0b3d75;text-align:center;font-weight:700}
.skip-link{position:absolute;left:-9999px;top:0;background:#fff;color:#0b3d75;padding:.5rem}
.skip-link:focus{left:.5rem;z-index:10}
.login-tabs{display:flex;gap:.5rem;margin:1rem 0}
.login-tabs [role=tab]{background:#fff;color:#0b4f9c}
.login-tabs [role=tab][aria-selected=true]{background:#0b4f9c;color:#fff}
.card{background:#fff;border:1px solid #d0d5dd;border-radius:8px;padding:1rem;max-width:560px}
.field{margin:.75rem 0;display:flex;flex-direction:column;gap:.25rem}
.field input{max-width:100%}
.check{display:flex;gap:.5rem;align-items:flex-start;margin:.75rem 0}
.note{color:#3d4451;font-size:.95rem}
`;

function docShell(title, header, mainContent) {
  return '<!doctype html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(title)} · e-Service เทศบาลนครสุขใจ</title>` +
    `<link rel="stylesheet" href="/static/app.css"><style>${STYLE}</style></head><body>` +
    '<a class="skip-link" href="#main">ข้ามไปเนื้อหาหลัก</a>' +
    header + `<main id="main" tabindex="-1">${mainContent}</main></body></html>`;
}

function anonHeader() {
  return '<header class="app-header"><p class="brand"><a href="/">e-Service เทศบาลนครสุขใจ</a> <small>(ระบบจำลอง)</small></p></header>';
}

function userHeader(req) {
  const u = req.user;
  const full = !needsRegister(req);
  const items = full ? NAV.filter((n) => n.roles.includes(u.role)) : [];
  const path = req.path || '';
  const links = items.map((n) => html`<li><a data-testid="${n.id}" href="${n.href}"${raw(path === n.href || path.startsWith(`${n.href}/`) ? ' aria-current="page"' : '')}>${n.label}</a></li>`);
  if (full && (u.role === 'officer' || u.role === 'head')) {
    links.push(html`<li><a data-testid="nav-bell" href="/notifications"${raw(path === '/notifications' ? ' aria-current="page"' : '')}>แจ้งเตือน <span class="bell-count" data-testid="bell-count">${bellCount(u)}</span></a></li>`);
  }
  const deptAttr = u.role === 'officer' && u.dept ? html` data-dept="${u.dept}"` : '';
  return render(html`<header class="app-header" data-testid="app-header">
<p class="brand"><a href="/">e-Service เทศบาลนครสุขใจ</a> <small>(ระบบจำลอง)</small></p>
${links.length ? html`<nav aria-label="เมนูหลัก"><ul>${links}</ul></nav>` : ''}
<div class="who"><span data-testid="user-name">${u.name}</span> · <span data-testid="user-role" data-role="${u.role}"${deptAttr}>${format.ROLE_TH[u.role] || u.role}</span>
<form method="post" action="/logout"><button type="submit" class="logout" data-testid="logout-btn">ออกจากระบบ</button></form></div>
</header>`);
}

/** HTML ทั้งหน้า · opts = { title, body, error, success } */
function renderPage(req, opts = {}) {
  const { title = 'e-Service', body = '', error, success } = opts;
  const flash = render(html`${error ? html`<div class="error" data-testid="action-error" role="alert">${error}</div>` : ''}${success ? html`<div class="success" data-testid="action-success" role="status">${success}</div>` : ''}`);
  return docShell(title, req.user ? userHeader(req) : anonHeader(), flash + render(body));
}

function sendPage(req, res, opts = {}) {
  return res.status(opts.status || 200).type('html').send(renderPage(req, opts));
}

function forbiddenPage(req, res) {
  return sendPage(req, res, {
    status: 403,
    title: 'ไม่มีสิทธิ์',
    body: html`<h1>ไม่มีสิทธิ์</h1><p data-testid="forbidden-msg" role="alert">${MSG.FORBIDDEN_PAGE}</p><p><a href="/">กลับหน้าแรก</a></p>`,
  });
}

function notFoundPage(req, res) {
  return sendPage(req, res, {
    status: 404,
    title: 'ไม่พบคำขอ',
    body: html`<h1>ไม่พบ</h1><p data-testid="not-found-msg" role="alert">${MSG.NOT_FOUND}</p><p><a href="/">กลับหน้าแรก</a></p>`,
  });
}

// ───────────────────────── RBAC middleware ─────────────────────────

function checkRoles(roles) {
  const bad = roles.filter((r) => !ROLES.includes(r));
  if (bad.length) throw new Error(`auth: unknown role(s) ${bad.join(',')}`);
}

/** หน้า HTML (CONTRACT 1): anon → /login · citizen ยังไม่ลงทะเบียน → /register · บทบาทไม่ตรง → 403 */
function requirePage(...roles) {
  roles = roles.flat();
  checkRoles(roles);
  return function pageGuard(req, res, next) {
    if (!req.user) return res.redirect(302, '/login');
    if (needsRegister(req)) return res.redirect(302, '/register');
    if (roles.length && !roles.includes(req.user.role)) return forbiddenPage(req, res);
    next();
  };
}

/** API (CONTRACT 5/6): anon (หรือ session เฉพาะลงทะเบียน) → 401 · บทบาทไม่ตรง → 403 */
function requireApi(...roles) {
  roles = roles.flat();
  checkRoles(roles);
  return function apiGuard(req, res, next) {
    if (!req.user || needsRegister(req)) return apiError(res, 401, 'UNAUTHENTICATED', MSG.UNAUTHENTICATED);
    if (roles.length && !roles.includes(req.user.role)) return apiError(res, 403, 'FORBIDDEN', MSG.FORBIDDEN);
    next();
  };
}

// ───────────────────────── ThaiD จำลอง: เลขบัตร + OTP + ล็อก ─────────────────────────

function getAttempt(hash) {
  return db.prepare('SELECT * FROM otp_attempts WHERE id_no_hash = ?').get(hash);
}

function upsertAttempt(hash, patch) {
  const cur = getAttempt(hash) || { fail_count: 0, locked_until: null, otp_sent_at: null };
  const row = { ...cur, ...patch };
  db.prepare(
    `INSERT INTO otp_attempts(id_no_hash, fail_count, locked_until, otp_sent_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id_no_hash) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until,
       otp_sent_at = excluded.otp_sent_at, updated_at = excluded.updated_at`,
  ).run(hash, row.fail_count, row.locked_until, row.otp_sent_at, clock.nowIso());
}

/** ล็อกอยู่ไหม (ตามนาฬิกาทดสอบ) · ถ้าพ้นเวลาแล้ว ปลดล็อกและเริ่มตัวนับที่ 0 · คืน lockedUntil ISO หรือ null */
function activeLock(hash) {
  const a = getAttempt(hash);
  if (!a || !a.locked_until) return null;
  if (clock.now().getTime() < clock.parseIso(a.locked_until).getTime()) return a.locked_until;
  upsertAttempt(hash, { fail_count: 0, locked_until: null });
  return null;
}

/** POST /api/auth/thaid/start */
function thaidStart(idNo) {
  if (!validIdNo(idNo)) return { status: 400, code: 'INVALID_ID', message: MSG.INVALID_ID };
  const s = String(idNo);
  const hash = pii.lookupHash(s);
  const lockedUntil = activeLock(hash);
  if (lockedUntil) return { status: 423, code: 'LOCKED', message: MSG.LOCKED, lockedUntil };
  upsertAttempt(hash, { otp_sent_at: clock.nowIso() });
  return { status: 200, ok: true };
}

function findOrCreateCitizen(idNo) {
  const hash = pii.lookupHash(idNo);
  let u = db.prepare('SELECT * FROM users WHERE id_no_hash = ?').get(hash);
  if (u) return u;
  // เลขบัตรที่ checksum ถูกแต่ไม่อยู่ใน seed: ThaiD จำลองส่งชื่อทดสอบมาให้ แล้วต้องลงทะเบียนครั้งแรก
  const now = clock.nowIso();
  const info = db.prepare(
    `INSERT INTO users(username, name, role, dept, id_no_enc, id_no_hash, id_masked, registered, active, created_at, updated_at)
     VALUES (NULL, ?, 'citizen', '', ?, ?, ?, 0, 1, ?, ?)`,
  ).run('ผู้ใช้ทดสอบ ThaiD', pii.encrypt(idNo), hash, pii.maskIdNo(idNo), now, now);
  u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return u;
}

/** POST /api/auth/thaid/verify (ตรวจ OTP + ล็อก) · สำเร็จคืน user (ยังไม่สร้าง session) */
const thaidVerify = db.transaction((idNo, otp) => {
  if (!validIdNo(idNo)) return { status: 400, code: 'INVALID_ID', message: MSG.INVALID_ID };
  const s = String(idNo);
  const hash = pii.lookupHash(s);
  const lockedUntil = activeLock(hash);
  if (lockedUntil) return { status: 423, code: 'LOCKED', message: MSG.LOCKED, lockedUntil };
  const cur = getAttempt(hash);
  const fails = cur ? cur.fail_count : 0;
  if (String(otp == null ? '' : otp).trim() !== OTP_CODE) {
    const n = fails + 1;
    if (n >= OTP_MAX_FAIL) {
      const until = clock.toIso(clock.now().getTime() + LOCK_MS);
      upsertAttempt(hash, { fail_count: n, locked_until: until });
      return { status: 423, code: 'LOCKED', message: MSG.LOCKED, lockedUntil: until };
    }
    upsertAttempt(hash, { fail_count: n, locked_until: null });
    return { status: 401, code: 'OTP_INVALID', message: MSG.OTP_INVALID, attemptsLeft: OTP_MAX_FAIL - n };
  }
  const user = findOrCreateCitizen(s);
  if (!user.active || user.role !== 'citizen') return { status: 403, code: 'FORBIDDEN', message: MSG.FORBIDDEN };
  upsertAttempt(hash, { fail_count: 0, locked_until: null }); // OTP ถูก → ตัวนับเป็น 0
  return { status: 200, ok: true, user };
});

function startCitizenSession(req, res, user) {
  if (req.session) session.destroy(req, res);
  const registered = !!user.registered;
  session.create(res, user.id, { scope: registered ? 'full' : 'register' });
  return registered;
}

// ───────────────────────── SSO เจ้าหน้าที่จำลอง ─────────────────────────

function staffLogin(username, pw) {
  const u = typeof username === 'string' && username.trim()
    ? db.prepare("SELECT * FROM users WHERE username = ? AND role <> 'citizen' AND active = 1").get(username.trim())
    : null;
  if (!u || typeof pw !== 'string' || !password.verifyPassword(pw, u.password_hash)) {
    return { status: 401, code: 'INVALID_CREDENTIALS', message: MSG.INVALID_CREDENTIALS };
  }
  return { status: 200, ok: true, user: u };
}

function startStaffSession(req, res, user) {
  if (req.session) session.destroy(req, res);
  session.create(res, user.id, { scope: 'full' });
  audit({ username: user.username, role: user.role, event: 'STAFF_LOGIN', detail: '' });
}

// ───────────────────────── ลงทะเบียน ─────────────────────────

/** คืน { errors:{mobile?,consent?,email?}, firstCode } หรือ { ok:true } แล้วบันทึก */
function doRegister(req, body) {
  const mobile = body.mobile == null ? '' : String(body.mobile).trim();
  const email = body.email == null ? '' : String(body.email).trim();
  const errors = {};
  let first = null;
  if (!validMobile(mobile)) { errors.mobile = MSG.INVALID_MOBILE; first = first || ['INVALID_MOBILE', MSG.INVALID_MOBILE]; }
  if (email && !validEmail(email)) { errors.email = MSG.INVALID_EMAIL; first = first || ['INVALID_EMAIL', MSG.INVALID_EMAIL]; }
  if (!isConsent(body.consent)) { errors.consent = MSG.CONSENT_REQUIRED; first = first || ['CONSENT_REQUIRED', MSG.CONSENT_REQUIRED]; }
  if (first) return { errors, code: first[0], message: first[1] };
  const now = clock.nowIso();
  db.prepare(
    'UPDATE users SET mobile_enc = ?, email_enc = ?, registered = 1, consent_at = ?, updated_at = ? WHERE id = ?',
  ).run(pii.encrypt(mobile), email ? pii.encrypt(email) : null, now, now, req.user.id);
  session.setScope(req, 'full');
  req.user.registered = 1;
  return { ok: true };
}

// ───────────────────────── หน้า /login และ /register ─────────────────────────

function loginPage(req, st = {}) {
  const tab = st.tab === 'staff' ? 'staff' : 'citizen';
  const idVal = st.idNo == null ? '' : String(st.idNo);
  const lock = st.lockedUntil
    ? html`<div role="alert"><p data-testid="lock-message">${MSG.LOCKED}</p>
<p>ปลดล็อกเวลา <time data-testid="lock-until" data-iso="${st.lockedUntil}" datetime="${st.lockedUntil}">${clock.formatThai(st.lockedUntil)}</time></p></div>`
    : '';
  const otp = st.otpStep
    ? html`<form method="post" action="/login" data-testid="otp-step" class="card" novalidate>
<input type="hidden" name="step" value="otp"><input type="hidden" name="idNo" value="${idVal}">
<p class="note">ระบบจำลองส่งรหัส OTP ไปยังเบอร์ที่ผูกกับ ThaiD แล้ว (โหมดทดสอบใช้ ${OTP_CODE})</p>
<div class="field"><label for="otp-input">รหัส OTP 6 หลัก</label>
<input id="otp-input" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" data-testid="otp-input" autofocus></div>
${st.otpError ? html`<div role="alert"><p data-testid="otp-error">${MSG.OTP_INVALID}</p>${st.attemptsLeft != null ? html`<p data-testid="otp-attempts-left">เหลือ ${st.attemptsLeft} ครั้ง</p>` : ''}</div>` : ''}
<button type="submit" data-testid="otp-submit">ยืนยัน OTP</button>
</form>`
    : '';
  const body = html`<h1>เข้าสู่ระบบ</h1>
<div class="login-tabs" role="tablist" aria-label="ประเภทผู้ใช้">
<button type="button" role="tab" id="tab-citizen" aria-controls="panel-citizen" aria-selected="${tab === 'citizen' ? 'true' : 'false'}" data-testid="login-tab-citizen">ประชาชน</button>
<button type="button" role="tab" id="tab-staff" aria-controls="panel-staff" aria-selected="${tab === 'staff' ? 'true' : 'false'}" data-testid="login-tab-staff">เจ้าหน้าที่</button>
</div>
<section id="panel-citizen" role="tabpanel" aria-labelledby="tab-citizen"${raw(tab === 'citizen' ? '' : ' hidden')}>
<form method="post" action="/login" class="card" novalidate>
<input type="hidden" name="step" value="thaid">
<div class="field"><label for="thaid-id-input">เลขบัตรประจำตัวประชาชน 13 หลัก</label>
<input id="thaid-id-input" name="idNo" type="text" inputmode="numeric" autocomplete="off" data-testid="thaid-id-input" value="${idVal}"${raw(st.otpStep ? '' : ' autofocus')}></div>
${st.idError ? html`<p data-testid="thaid-error" role="alert">${MSG.INVALID_ID}</p>` : ''}
<button type="submit" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
<p class="note">ThaiD ในระบบนี้เป็นตัวจำลอง ไม่เชื่อมต่อระบบจริง</p>
</form>
${lock}
${otp}
</section>
<section id="panel-staff" role="tabpanel" aria-labelledby="tab-staff"${raw(tab === 'staff' ? '' : ' hidden')}>
<form method="post" action="/login" class="card" novalidate>
<input type="hidden" name="step" value="staff">
<div class="field"><label for="staff-username">ชื่อผู้ใช้</label>
<input id="staff-username" name="username" type="text" autocomplete="username" data-testid="staff-username" value="${st.username || ''}"></div>
<div class="field"><label for="staff-password">รหัสผ่าน</label>
<input id="staff-password" name="password" type="password" autocomplete="current-password" data-testid="staff-password"></div>
${st.staffError ? html`<p data-testid="staff-error" role="alert">${MSG.INVALID_CREDENTIALS}</p>` : ''}
<button type="submit" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
</form>
</section>
<script>
(function () {
  var tabs = document.querySelectorAll('[role=tab]');
  function show(t) {
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i] === t;
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      document.getElementById(tabs[i].getAttribute('aria-controls')).hidden = !on;
    }
  }
  for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener('click', function (e) { show(e.currentTarget); });
})();
</script>`;
  // หน้า login ไม่มี header ของผู้ใช้ (แม้มี session ค้าง) เพื่อให้สลับบัญชีได้
  return docShell('เข้าสู่ระบบ', anonHeader(), render(body));
}

function registerPage(req, st = {}) {
  const e = st.errors || {};
  const body = html`<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<form method="post" action="/register" class="card" novalidate>
<div class="field"><label for="reg-name">ชื่อ-สกุล (จาก ThaiD แก้ไขไม่ได้)</label>
<input id="reg-name" name="name" type="text" data-testid="reg-name" value="${req.user.name}" readonly aria-readonly="true"></div>
<div class="field"><label for="reg-mobile">เบอร์มือถือ (บังคับ)</label>
<input id="reg-mobile" name="mobile" type="text" inputmode="numeric" autocomplete="tel" data-testid="reg-mobile" value="${st.mobile || ''}"${raw(e.mobile ? ' aria-invalid="true" aria-describedby="reg-error-mobile"' : '')}>
${e.mobile ? html`<p id="reg-error-mobile" data-testid="reg-error-mobile" role="alert">${e.mobile}</p>` : ''}</div>
<div class="field"><label for="reg-email">อีเมล (ไม่บังคับ)</label>
<input id="reg-email" name="email" type="text" inputmode="email" autocomplete="email" data-testid="reg-email" value="${st.email || ''}"${raw(e.email ? ' aria-invalid="true"' : '')}>
${e.email ? html`<p data-testid="reg-error-email" role="alert">${e.email}</p>` : ''}</div>
<div class="check"><input id="reg-consent" name="consent" type="checkbox" value="true" data-testid="reg-consent"${raw(st.consent ? ' checked' : '')}>
<label for="reg-consent">ยินยอมให้เทศบาลนครสุขใจ (หน่วยงานสมมติ) ประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</label></div>
${e.consent ? html`<p data-testid="reg-error-consent" role="alert">${e.consent}</p>` : ''}
<button type="submit" data-testid="reg-submit">ลงทะเบียน</button>
</form>`;
  return renderPage(req, { title: 'ลงทะเบียน', body });
}

// ───────────────────────── ลงทะเบียน route ─────────────────────────

function register(app) {
  const r = express.Router();
  const sendHtml = (res, s, status = 200) => res.status(status).type('html').send(s);

  // ── หน้า ──
  r.get('/login', (req, res) => sendHtml(res, loginPage(req, { tab: req.query.tab === 'staff' ? 'staff' : 'citizen' })));

  r.post('/login', (req, res) => {
    const b = req.body || {};
    const step = String(b.step || '');
    if (step === 'staff') {
      const out = staffLogin(b.username, b.password);
      if (!out.ok) return sendHtml(res, loginPage(req, { tab: 'staff', staffError: true, username: b.username }), 401);
      startStaffSession(req, res, out.user);
      return res.redirect(303, landingFor(out.user));
    }
    const idNo = b.idNo == null ? '' : String(b.idNo).trim();
    if (step === 'otp') {
      const out = thaidVerify(idNo, b.otp);
      if (out.status === 400) return sendHtml(res, loginPage(req, { idNo, idError: true }), 400);
      if (out.status === 423) return sendHtml(res, loginPage(req, { idNo, lockedUntil: out.lockedUntil }), 423);
      if (out.status === 401) return sendHtml(res, loginPage(req, { idNo, otpStep: true, otpError: true, attemptsLeft: out.attemptsLeft }), 401);
      if (!out.ok) return sendHtml(res, loginPage(req, { idNo }), out.status);
      const registered = startCitizenSession(req, res, out.user);
      return res.redirect(303, registered ? '/citizen' : '/register');
    }
    // step = thaid (เริ่ม)
    const out = thaidStart(idNo);
    if (out.status === 400) return sendHtml(res, loginPage(req, { idNo, idError: true }), 400);
    if (out.status === 423) return sendHtml(res, loginPage(req, { idNo, lockedUntil: out.lockedUntil }), 423);
    return sendHtml(res, loginPage(req, { idNo, otpStep: true }));
  });

  r.get('/register', (req, res) => {
    if (!req.user) return res.redirect(302, '/login');
    if (!needsRegister(req)) return res.redirect(302, landingFor(req.user));
    return sendHtml(res, registerPage(req));
  });

  r.post('/register', (req, res) => {
    if (!req.user) return res.redirect(303, '/login');
    if (!needsRegister(req)) return res.redirect(303, landingFor(req.user));
    const b = req.body || {};
    const out = doRegister(req, b);
    if (!out.ok) {
      return sendHtml(res, registerPage(req, { errors: out.errors, mobile: b.mobile, email: b.email, consent: isConsent(b.consent) }), 400);
    }
    return res.redirect(303, '/citizen');
  });

  const logoutPage = (req, res) => { session.destroy(req, res); res.redirect(303, '/login'); };
  r.post('/logout', logoutPage);
  r.get('/logout', logoutPage);

  // ── API (CONTRACT 6.1) ──
  r.post('/api/auth/thaid/start', (req, res) => {
    const out = thaidStart((req.body || {}).idNo);
    if (!out.ok) return apiError(res, out.status, out.code, out.message, out.lockedUntil ? { lockedUntil: out.lockedUntil } : undefined);
    res.status(200).json({ status: 'OTP_SENT' });
  });

  r.post('/api/auth/thaid/verify', (req, res) => {
    const b = req.body || {};
    const out = thaidVerify(b.idNo == null ? '' : (typeof b.idNo === 'number' ? String(b.idNo) : b.idNo), b.otp);
    if (!out.ok) {
      const extra = out.status === 401 ? { attemptsLeft: out.attemptsLeft } : out.status === 423 ? { lockedUntil: out.lockedUntil } : undefined;
      return apiError(res, out.status, out.code, out.message, extra);
    }
    const registered = startCitizenSession(req, res, out.user);
    res.status(200).json({ registered, landing: registered ? '/citizen' : '/register' });
  });

  r.post('/api/auth/register', (req, res) => {
    if (!req.user) return apiError(res, 401, 'UNAUTHENTICATED', MSG.UNAUTHENTICATED);
    if (req.user.role !== 'citizen') return apiError(res, 403, 'FORBIDDEN', MSG.FORBIDDEN);
    if (!needsRegister(req)) return apiError(res, 409, 'ALREADY_REGISTERED', MSG.ALREADY_REGISTERED);
    const out = doRegister(req, req.body || {});
    if (!out.ok) return apiError(res, 400, out.code, out.message);
    res.status(201).json({ registered: true, landing: '/citizen' });
  });

  r.post('/api/auth/staff/login', (req, res) => {
    const b = req.body || {};
    const out = staffLogin(b.username, b.password);
    if (!out.ok) return apiError(res, out.status, out.code, out.message);
    startStaffSession(req, res, out.user);
    const u = out.user;
    res.status(200).json({ role: u.role, dept: u.dept || '', landing: landingFor(u) });
  });

  r.post('/api/auth/logout', (req, res) => {
    session.destroy(req, res);
    res.status(204).end();
  });

  r.get('/api/me', (req, res) => {
    if (!req.user) return apiError(res, 401, 'UNAUTHENTICATED', MSG.UNAUTHENTICATED);
    const u = req.user;
    const out = { username: u.username || null, name: u.name, role: u.role, dept: u.dept || '' };
    if (u.role === 'citizen') out.registered = !needsRegister(req);
    res.json(out);
  });

  // method อื่นของเส้นทาง auth → 405
  const notAllowed = (req, res) => apiError(res, 405, 'METHOD_NOT_ALLOWED', MSG.METHOD_NOT_ALLOWED);
  r.all(['/api/auth/thaid/start', '/api/auth/thaid/verify', '/api/auth/register', '/api/auth/staff/login', '/api/auth/logout', '/api/me'], notAllowed);

  app.use(r);
}

module.exports = register;
Object.assign(module.exports, {
  requirePage, requireApi, renderPage, sendPage, forbiddenPage, notFoundPage, apiError, audit, auditFor,
  validIdNo, validMobile, needsRegister, landingFor, MSG, ROLES, NAV,
});
