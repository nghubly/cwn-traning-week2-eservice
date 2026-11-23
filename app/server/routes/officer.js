'use strict';
/**
 * B07 · เจ้าหน้าที่/หัวหน้า: คิว · รับเรื่อง · ตีกลับ · ส่งต่อ · อนุมัติ/ไม่อนุมัติ · ออกเอกสาร · PDPA · สิทธิ์ไฟล์แนบ
 * ที่มา: REQUIREMENTS BR-16..21 BR-24 BR-29 §4 · CONTRACT §2.6–2.8 §4.1 §5 §6.3 §6.7 · DECISIONS §5 §9 §10 §11 §18
 *        BUGS B07 B08 B09 B11 B12
 *
 * ───────────── หน้า (HTML · ฟอร์ม POST แล้ว 303 กลับ GET) ─────────────
 *   GET  /officer/queue?filter=all|unclaimed|mine      officer (แผนกตัวเอง) · head (ทุกแผนก อ่านอย่างเดียว)
 *   GET  /officer/cases/:caseNo                         officer · head (ไม่มีเลข → 404 not-found-msg)
 *   POST /officer/cases/:caseNo/(claim|return|forward|approve|reject|issue|unmask)   ฟอร์มของหน้า
 *   GET  /head/approvals                                head (PENDING_APPROVAL เรียง BR-16)
 *
 * ───────────── API (JSON · ข้อผิดพลาด {"code","message"}) ─────────────
 *   GET  /api/officer/queue?filter=…                    {items:[{caseNo,serviceId,applicantName,idMasked,status,step,owner,dueAt,slaLevel}], workload}
 *   POST /api/officer/cases/:caseNo/claim               {owner}        ลำดับตรวจ: สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT
 *   POST /api/officer/cases/:caseNo/return {reason}     {status:'NEED_FIX', returnCount}
 *   POST /api/officer/cases/:caseNo/forward {note?}     {status:'IN_REVIEW', step:2} | {status:'PENDING_APPROVAL'}
 *   POST /api/cases/:caseNo/approve                     {status:'APPROVED'}   SV-01 ผู้ถือเรื่อง · SV-02/03 head ที่ PENDING_APPROVAL
 *   POST /api/cases/:caseNo/reject {reason}             {status:'REJECTED', closedAt}
 *   POST /api/officer/cases/:caseNo/issue               {docNo, verifyCode, status:'COMPLETED'}   ผู้ออกเอกสาร (A-27)
 *   POST /api/officer/cases/:caseNo/unmask {reason}     {idNo} + Audit UNMASK
 *   GET  /api/cases/:caseNo                             CONTRACT 6.7 (เจ้าหน้าที่ได้ idMasked เท่านั้น · ประชาชนเจ้าของได้ idNo)
 *   GET  /api/cases/:caseNo/files · GET /api/files/:fileId   สิทธิ์ตาม BR-29
 *   POST /api/cases/:caseNo/resubmit                    (สำรอง · ถ้า citizen.js ไม่ได้ทำ) ส่งแก้ + หยุดนับ SLA (BR-13)
 *   hook ทุก request (order 10): NEED_FIX ที่เลย 168 ชม. → CANCELLED (เวลายกเลิก = เส้นตาย) · CONTRACT 0.7 / A-46
 *
 * ───────────── ข้อตกลงกับบล็อกอื่น ─────────────
 *   - cases.dept = แผนกที่ถือเรื่องตอนนี้ (registry | works | head | NULL) · owner = username หรือ NULL · issuer = ทะเบียนที่รับขั้นแรก
 *   - APPROVED → owner NULL, dept 'registry' · PENDING_APPROVAL → owner NULL, dept 'head' · COMPLETED → owner = issuer
 *   - ออกเอกสาร: ถ้า routes/docs.js (B09) export createDocument({db, caseRow, issuer, now}) → {docNo, verifyCode}
 *     ไฟล์นี้จะเรียกตัวนั้นภายใน transaction (ห้ามเขียน audit/สถานะเอง ไฟล์นี้ทำให้) · ไม่มี → ใช้ตัวสำรองในไฟล์นี้
 *     (ลายเซ็นสูตรเดียวกับ seed.docSignature · อายุ SV-01 ออก+89 วัน · SV-02/03 ครบรอบปี−1 วัน · 29 ก.พ. → 28 ก.พ.)
 *   - ฟังก์ชันที่บล็อกอื่นใช้ได้: require('./officer').helpers (ดูท้ายไฟล์)
 *
 * BUG_MODE: B07 officer อนุมัติ SV-02/03 ได้ (API ไม่ตรวจสิทธิ์ ปุ่มยังซ่อน) · B08 claim ข้ามการตรวจผู้ถือ (คนที่ 2 ได้ 200 เป็นผู้ถือแทน)
 *           B09 API คิวส่ง idNo เต็ม (จอยังปิดบัง) · B11 unmask ไม่บันทึก Audit · B12 ตีกลับครั้งที่ 3 ได้ (ปุ่มยังแสดง)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const dbm = require('../db');
const clock = require('../lib/clock');
const pii = require('../lib/pii');
const session = require('../lib/session');
const hooks = require('../lib/hooks');
const format = require('../lib/format');
const rules = require('../lib/rules');
const { isBug } = require('../lib/bugmode');
const { html, raw } = require('../lib/html');
const auth = require('./auth');

const { db } = dbm;

// ───────────────────────── ค่าคงที่ของกฎ ─────────────────────────
const MAX_WORKLOAD = 10;            // BR-18 (นับ IN_REVIEW ที่ตัวเองถือ · ตรวจเฉพาะตอนรับเรื่อง)
const MAX_RETURNS = 2;              // BR-19
const MIN_REASON_CHARS = 10;        // BR-19 (นับหลังตัดช่องว่างหัวท้าย)
const FIX_WINDOW_MS = 168 * 3600 * 1000; // BR-20 (7 วันปฏิทิน)
const MAX_FILE_BYTES = 5242880;     // BR-07
const MAX_FILES_PER_CASE = 5;       // BR-07
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED']; // TEST-DATA 9.1 (ไม่รวม NEED_FIX / PENDING_APPROVAL / ปิดแล้ว)
const FILTERS = ['all', 'unclaimed', 'mine'];
const FILTER_TH = { all: 'ทั้งหมด', unclaimed: 'ยังไม่มีผู้รับ', mine: 'ของฉัน' };
const DEPT_TH = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา', head: 'หัวหน้าฝ่าย' };
const STEP_TH = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const EVENT_TH = {
  SUBMIT: 'ยื่นคำขอและชำระเงิน', CLAIM: 'รับเรื่อง', RETURN: 'ตีกลับให้แก้ไข', RESUBMIT: 'ประชาชนส่งแก้ไข',
  FORWARD: 'ส่งต่อ', APPROVE: 'อนุมัติ', REJECT: 'ไม่อนุมัติ', ISSUE: 'ออกเอกสาร', CANCEL: 'ยกเลิกคำขอ',
  AUTO_CANCEL: 'ระบบยกเลิกอัตโนมัติ (เลยเวลาแก้ไข)',
};
const NO_OWNER_TH = 'ยังไม่มีผู้รับ';

const MSG = {
  NOT_FOUND: 'ไม่พบคำขอ',
  FILE_NOT_FOUND: 'ไม่พบไฟล์',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
};

let BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

/** ข้อผิดพลาดของการกระทำ · field = ช่องที่ผิด (return | reject | unmask) ให้หน้าแสดงใต้ช่องนั้น */
class ActionError extends Error {
  constructor(status, code, message, field = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
const fail = (status, code, field = null) => new ActionError(status, code, MSG[code], field);

// ───────────────────────── อ่านข้อมูล ─────────────────────────

const CASE_SQL = `SELECT c.*, u.name AS applicant_name, u.id_masked AS applicant_id_masked, u.id_no_enc AS applicant_id_enc,
  s.name AS service_name FROM cases c JOIN users u ON u.id = c.user_id LEFT JOIN services s ON s.id = c.service_id`;

function loadCase(caseNo) {
  if (typeof caseNo !== 'string' || !caseNo || caseNo.length > 40) return null;
  return db.prepare(`${CASE_SQL} WHERE c.case_no = ?`).get(caseNo) || null;
}

function fullIdOf(c) {
  try { return pii.decrypt(c.applicant_id_enc) || ''; } catch { return ''; }
}
function idMaskedOf(c) {
  return c.applicant_id_masked || pii.maskIdNo(fullIdOf(c));
}
function serviceLabel(c) {
  return `${c.service_id} ${c.service_name || format.SERVICE_TH[c.service_id] || ''}`.trim();
}
function stepOf(c) {
  if (c.service_id !== 'SV-03') return null;
  return c.step || (c.dept === 'works' ? 2 : c.dept === 'head' ? 3 : 1);
}
function workDept(c) {
  return c.dept === 'registry' || c.dept === 'works' ? c.dept : null;
}
function workloadOf(username) {
  if (!username) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM cases WHERE owner = ? AND status = 'IN_REVIEW'").get(username).n;
}
function docOf(caseNo) {
  return db.prepare('SELECT doc_no, verify_code, valid_until, signer FROM documents WHERE case_no = ?').get(caseNo) || null;
}
function levelOf(c, hol) {
  return rules.slaLevel({ status: c.status, due_at: c.due_at }, clock.now(), hol);
}
function isoOrNull(v) {
  if (!v) return null;
  try { return clock.toIso(v); } catch { return null; }
}
function staffName(username) {
  if (!username) return '';
  const r = db.prepare('SELECT name FROM users WHERE username = ?').get(username);
  return r ? r.name : username;
}
/** ความยาวเหตุผลหลังตัดช่องว่างหัวท้าย (นับเป็นตัวอักษร/code point) */
function reasonText(v) {
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}
function charLen(s) {
  return Array.from(s).length;
}
function cmpQueue(a, b) {
  const d = (a.due_at ? clock.toMs(a.due_at) : Infinity) - (b.due_at ? clock.toMs(b.due_at) : Infinity);
  if (d) return d;
  return a.case_no < b.case_no ? -1 : a.case_no > b.case_no ? 1 : 0;
}

/** ไฟล์แนบของคำขอ (รวมไฟล์ที่แนบตอนเป็นร่าง ถ้าบล็อกชำระเงินยังไม่ได้ผูก case_no) */
function caseFiles(c) {
  const draftIds = new Set();
  if (c.draft_id) draftIds.add(c.draft_id);
  for (const d of db.prepare('SELECT id FROM drafts WHERE case_no = ?').all(c.case_no)) draftIds.add(d.id);
  const ids = [...draftIds];
  const extra = ids.length ? ` OR draft_id IN (${ids.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT * FROM files WHERE case_no = ?${extra} ORDER BY created_at, id`).all(c.case_no, ...ids);
}
function docLabels(serviceId) {
  const out = {};
  for (const r of db.prepare('SELECT doc_key, label FROM service_docs WHERE service_id = ?').all(serviceId)) out[r.doc_key] = r.label;
  return out;
}

function addEvent(caseNo, time, actor, event, fromStatus, toStatus, note = null) {
  db.prepare('INSERT INTO case_events (case_no, time, actor, event, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(caseNo, time, actor, event, fromStatus, toStatus, note);
}

// ───────────────────────── สิทธิ์ (ใช้ทั้งปุ่มบนจอและ API) ─────────────────────────

const isOfficer = (u) => !!u && u.role === 'officer';
const isHead = (u) => !!u && u.role === 'head';
const isStaffViewer = (u) => isOfficer(u) || isHead(u);

function claimableState(c) {
  return c.status === 'SUBMITTED' || (c.status === 'IN_REVIEW' && !c.owner);
}
/** แผนกที่ใช้ตรวจสิทธิ์รับเรื่อง: แผนกปัจจุบัน · คำขอที่ปิด/ยกเลิก (dept NULL) ถือเป็นทะเบียน → 409 ไม่ใช่ 403 */
function claimDeptOf(c) {
  return workDept(c) || 'registry';
}
function canClaim(u, c) {
  return isOfficer(u) && workDept(c) === u.dept && claimableState(c);
}
function holdsAtReview(u, c) {
  return isOfficer(u) && c.status === 'IN_REVIEW' && !!c.owner && c.owner === u.username;
}
function canReturn(u, c) {
  return holdsAtReview(u, c) && (c.return_count < MAX_RETURNS || isBug('B12')); // B12: ปุ่มยังแสดงครั้งที่ 3
}
function canForward(u, c) {
  return holdsAtReview(u, c) && (c.service_id === 'SV-02' || c.service_id === 'SV-03');
}
/** อนุมัติ/ไม่อนุมัติ (ปุ่ม): SV-01 ผู้ถือเรื่องที่ IN_REVIEW · SV-02/03 head ที่ PENDING_APPROVAL (B07 ไม่เปลี่ยนปุ่ม) */
function canDecide(u, c) {
  if (c.service_id === 'SV-01') return holdsAtReview(u, c);
  return isHead(u) && c.status === 'PENDING_APPROVAL';
}
function canIssue(u, c) {
  return isOfficer(u) && c.status === 'APPROVED' && !!c.issuer && c.issuer === u.username;
}
/** BR-29: officer = แผนกตนเอง (ขั้นปัจจุบันหรือเคยผ่าน) · head = ทุกแผนก · citizen = ของตัวเอง · อื่น ๆ ไม่ได้ */
function canViewFiles(u, c) {
  if (!u) return false;
  if (u.role === 'head') return true;
  if (u.role === 'citizen') return c.user_id === u.id;
  if (u.role !== 'officer') return false;
  if (u.dept === 'registry') return true; // ทุกบริการเริ่มที่ฝ่ายทะเบียน → ขั้นปัจจุบันหรือเคยผ่านเสมอ
  if (u.dept === 'works') {
    return c.service_id === 'SV-03' && (c.dept === 'works' || (Number(c.step) || 0) >= 2 || !!c.works_officer);
  }
  return false;
}

// ───────────────────────── การกระทำ (transaction · โยน ActionError) ─────────────────────────

/** รับเรื่อง (BR-17 BR-18) · ลำดับตรวจ: สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT */
const claimCase = (user, caseNo) => db.transaction(() => {
  const c = loadCase(caseNo);
  if (!c) throw fail(404, 'NOT_FOUND');
  if (!isOfficer(user) || claimDeptOf(c) !== user.dept) throw fail(403, 'FORBIDDEN');
  // B08: ข้ามการตรวจว่ามีผู้ถือแล้ว (คนที่ 2 ได้ 200 และกลายเป็นผู้ถือแทน)
  const skipOwnerCheck = isBug('B08') && c.status === 'IN_REVIEW';
  if (c.owner && !skipOwnerCheck && ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX'].includes(c.status)) throw fail(409, 'ALREADY_CLAIMED');
  if (c.status !== 'SUBMITTED' && c.status !== 'IN_REVIEW') throw fail(409, 'INVALID_STATE');
  if (workloadOf(user.username) >= MAX_WORKLOAD) throw fail(409, 'WORKLOAD_LIMIT');

  const now = clock.nowIso();
  const dept = workDept(c) || 'registry';
  db.prepare(`UPDATE cases SET status = 'IN_REVIEW', owner = @u, dept = @dept,
      registry_officer = CASE WHEN @dept = 'registry' THEN @u ELSE registry_officer END,
      issuer = CASE WHEN @dept = 'registry' THEN @u ELSE issuer END,
      works_officer = CASE WHEN @dept = 'works' THEN @u ELSE works_officer END,
      updated_at = @now WHERE case_no = @caseNo`).run({ u: user.username, dept, now, caseNo: c.case_no });
  addEvent(c.case_no, now, user.username, 'CLAIM', c.status, 'IN_REVIEW', dept === 'works' ? 'รับเรื่องขั้นฝ่ายโยธา' : null);
  auth.auditFor(user, 'CLAIM', { caseNo: c.case_no, fromStatus: c.status, toStatus: 'IN_REVIEW' });
  return { owner: user.username, status: 'IN_REVIEW' };
})();

/** ตีกลับ (BR-19 BR-20) · ผู้ถือเรื่องที่ IN_REVIEW · สูงสุด 2 ครั้ง · เหตุผล ≥ 10 ตัว */
const returnCase = (user, caseNo, reason) => db.transaction(() => {
  const c = loadCase(caseNo);
  if (!c) throw fail(404, 'NOT_FOUND');
  if (!isOfficer(user) || !c.owner || c.owner !== user.username) throw fail(403, 'FORBIDDEN');
  if (c.status !== 'IN_REVIEW') throw fail(409, 'INVALID_STATE');
  if (c.return_count >= MAX_RETURNS && !isBug('B12')) throw fail(409, 'RETURN_LIMIT'); // B12: ตีกลับครั้งที่ 3 ได้
  const text = reasonText(reason);
  if (charLen(text) < MIN_REASON_CHARS) throw fail(400, 'REASON_TOO_SHORT', 'return');

  const now = clock.nowIso();
  const n = c.return_count + 1;
  const deadline = clock.toIso(clock.addMs(now, FIX_WINDOW_MS));
  db.prepare(`UPDATE cases SET status = 'NEED_FIX', return_count = ?, need_fix_at = ?, fix_deadline = ?, updated_at = ?
      WHERE case_no = ?`).run(n, now, deadline, now, c.case_no);
  db.prepare(`INSERT OR REPLACE INTO case_returns (case_no, n, returned_at, returned_by, reason, resubmitted_at, paused_days)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)`).run(c.case_no, n, now, user.username, text);
  addEvent(c.case_no, now, user.username, 'RETURN', 'IN_REVIEW', 'NEED_FIX', text);
  auth.auditFor(user, 'RETURN', { caseNo: c.case_no, fromStatus: 'IN_REVIEW', toStatus: 'NEED_FIX', detail: text });
  return { status: 'NEED_FIX', returnCount: n, fixDeadline: deadline };
})();

/** ส่งต่ออัตโนมัติตามเส้นทาง (BR-21): SV-02 ทะเบียน → หัวหน้า · SV-03 ทะเบียน → โยธา → หัวหน้า (เลือกปลายทางไม่ได้) */
const forwardCase = (user, caseNo, note) => db.transaction(() => {
  const c = loadCase(caseNo);
  if (!c) throw fail(404, 'NOT_FOUND');
  if (!isOfficer(user) || !c.owner || c.owner !== user.username) throw fail(403, 'FORBIDDEN');
  if (c.status !== 'IN_REVIEW') throw fail(409, 'INVALID_STATE');
  if (c.service_id !== 'SV-02' && c.service_id !== 'SV-03') throw fail(409, 'INVALID_STATE'); // SV-01 ตัดสินที่เจ้าหน้าที่

  const text = reasonText(note).slice(0, 1000);
  const now = clock.nowIso();
  let to;
  let step = null;
  let dept;
  let defaultNote;
  if (c.service_id === 'SV-03' && stepOf(c) === 1) {
    to = 'IN_REVIEW'; step = 2; dept = 'works'; defaultNote = 'ส่งต่อฝ่ายโยธา (ขั้นตอน 2/3)';
  } else {
    to = 'PENDING_APPROVAL'; step = c.service_id === 'SV-03' ? 3 : null; dept = 'head'; defaultNote = 'ส่งต่อหัวหน้าฝ่ายอนุมัติ';
  }
  db.prepare('UPDATE cases SET status = ?, step = ?, dept = ?, owner = NULL, updated_at = ? WHERE case_no = ?')
    .run(to, step, dept, now, c.case_no);
  addEvent(c.case_no, now, user.username, 'FORWARD', 'IN_REVIEW', to, text ? `${defaultNote} · ${text}` : defaultNote);
  auth.auditFor(user, 'FORWARD', { caseNo: c.case_no, fromStatus: 'IN_REVIEW', toStatus: to, detail: text });
  return to === 'IN_REVIEW' ? { status: to, step } : (step ? { status: to, step } : { status: to });
})();

/**
 * ตรวจอำนาจตัดสิน (BR-21): SV-01 = ผู้ถือเรื่อง (officer) ที่ IN_REVIEW · SV-02/03 = head ที่ PENDING_APPROVAL
 * forApprove + B07 → officer อนุมัติ SV-02/03 ได้ (ไม่ตรวจสิทธิ์)
 */
function assertCanDecide(user, c, forApprove) {
  if (c.service_id === 'SV-01') {
    if (!isOfficer(user) || !c.owner || c.owner !== user.username) throw fail(403, 'FORBIDDEN'); // head ใช้กับ SV-01 → 403
    if (c.status !== 'IN_REVIEW') throw fail(409, 'INVALID_STATE');
    return;
  }
  if (isHead(user)) {
    if (c.status !== 'PENDING_APPROVAL') throw fail(409, 'INVALID_STATE');
    return;
  }
  if (forApprove && isOfficer(user) && isBug('B07')) { // B07: API ไม่ตรวจสิทธิ์อนุมัติขั้นหัวหน้า
    if (c.status !== 'IN_REVIEW' && c.status !== 'PENDING_APPROVAL') throw fail(409, 'INVALID_STATE');
    return;
  }
  throw fail(403, 'FORBIDDEN'); // เจ้าหน้าที่ใช้กับ SV-02/03
}

const approveCase = (user, caseNo) => db.transaction(() => {
  const c = loadCase(caseNo);
  if (!c) throw fail(404, 'NOT_FOUND');
  assertCanDecide(user, c, true);
  const now = clock.nowIso();
  db.prepare(`UPDATE cases SET status = 'APPROVED', approved_by = ?, approved_at = ?, owner = NULL, dept = 'registry',
      issuer = COALESCE(issuer, registry_officer, ?), updated_at = ? WHERE case_no = ?`)
    .run(user.username, now, user.username, now, c.case_no);
  addEvent(c.case_no, now, user.username, 'APPROVE', c.status, 'APPROVED', null);
  auth.auditFor(user, 'APPROVE', { caseNo: c.case_no, fromStatus: c.status, toStatus: 'APPROVED' });
  return { status: 'APPROVED' };
})();

const rejectCase = (user, caseNo, reason) => db.transaction(() => {
  const c = loadCase(caseNo);
  if (!c) throw fail(404, 'NOT_FOUND');
  assertCanDecide(user, c, false);
  const text = reasonText(reason);
  if (charLen(text) < MIN_REASON_CHARS) throw fail(400, 'REASON_TOO_SHORT', 'reject');
  const now = clock.nowIso();
  db.prepare("UPDATE cases SET status = 'REJECTED', closed_at = ?, dept = NULL, updated_at = ? WHERE case_no = ?")
    .run(now, now, c.case_no);
  addEvent(c.case_no, now, user.username, 'REJECT', c.status, 'REJECTED', text);
  auth.auditFor(user, 'REJECT', { caseNo: c.case_no, fromStatus: c.status, toStatus: 'REJECTED', detail: text });
  return { status: 'REJECTED', closedAt: now };
})();

/** ออกเอกสาร (FR-17 · A-27): เฉพาะ APPROVED และผู้ออกเอกสาร = เจ้าหน้าที่ทะเบียนที่รับขั้นแรก */
const issueCase = (user, caseNo) => db.transaction(() => {
  const c = loadCase(caseNo);
  if (!c) throw fail(404, 'NOT_FOUND');
  if (!isOfficer(user) || !c.issuer || c.issuer !== user.username) throw fail(403, 'FORBIDDEN');
  if (c.status !== 'APPROVED' || docOf(c.case_no)) throw fail(409, 'INVALID_STATE');
  const now = clock.nowIso();
  const doc = createDocument(c, user, now);
  db.prepare("UPDATE cases SET status = 'COMPLETED', closed_at = ?, dept = NULL, owner = issuer, updated_at = ? WHERE case_no = ?")
    .run(now, now, c.case_no);
  addEvent(c.case_no, now, user.username, 'ISSUE', 'APPROVED', 'COMPLETED', doc.docNo);
  auth.auditFor(user, 'ISSUE', { caseNo: c.case_no, fromStatus: 'APPROVED', toStatus: 'COMPLETED', detail: doc.docNo });
  return { docNo: doc.docNo, verifyCode: doc.verifyCode, status: 'COMPLETED' };
})();

/** แสดงเลขบัตรเต็ม (BR-24): officer/head + เหตุผลไม่ว่าง + Audit UNMASK (B11: ไม่บันทึก) */
function unmaskCase(user, caseNo, reason) {
  const c = loadCase(caseNo);
  if (!c) throw fail(404, 'NOT_FOUND');
  if (!isStaffViewer(user)) throw fail(403, 'FORBIDDEN');
  const text = reasonText(reason);
  if (!text) throw fail(400, 'REASON_REQUIRED', 'unmask');
  const idNo = fullIdOf(c);
  if (!isBug('B11')) auth.auditFor(user, 'UNMASK', { caseNo: c.case_no, detail: text });
  return { idNo };
}

/** ยกเลิกอัตโนมัติ: NEED_FIX ที่ตอนนี้ ≥ เวลาตีกลับ + 168 ชม. → CANCELLED · เวลายกเลิก = เส้นตาย (A-46) */
function autoCancelExpired() {
  const rows = db.prepare("SELECT case_no, need_fix_at, fix_deadline FROM cases WHERE status = 'NEED_FIX'").all();
  if (!rows.length) return 0;
  const now = clock.now();
  let n = 0;
  for (const r of rows) {
    const deadline = isoOrNull(r.fix_deadline) || (r.need_fix_at ? clock.toIso(clock.addMs(r.need_fix_at, FIX_WINDOW_MS)) : null);
    if (!deadline || clock.cmp(now, deadline) < 0) continue;
    db.transaction(() => {
      const info = db.prepare(`UPDATE cases SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = 'auto-fix-expired', dept = NULL,
          updated_at = ? WHERE case_no = ? AND status = 'NEED_FIX'`).run(deadline, deadline, r.case_no);
      if (info.changes) {
        addEvent(r.case_no, deadline, 'system', 'AUTO_CANCEL', 'NEED_FIX', 'CANCELLED', 'เลยเวลาแก้ไข 168 ชั่วโมง ระบบยกเลิกคำขออัตโนมัติ');
        n++;
      }
    })();
  }
  return n;
}

// ───────────────────────── ส่งแก้ไข (สำรอง · BR-13 BR-18 BR-20) ─────────────────────────

function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}
const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
/** รหัสสุ่มแบบตัวอักษรล้วน (ไม่มีตัวเลขติดกันชนการตรวจ PDPA) */
function letterId(n = 20) {
  const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < n; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

/** ประชาชนส่งแก้ไข: คืนผู้ถือเดิม (แม้เกิน 10) · กำหนดเสร็จใหม่ = เดิม + วันทำการใน (วันตีกลับ, วันส่งแก้] */
function resubmitCase(user, caseNo, files = [], body = {}) {
  autoCancelExpired();
  return db.transaction(() => {
    const c = loadCase(caseNo);
    if (!c || !user || user.role !== 'citizen' || c.user_id !== user.id) throw fail(404, 'NOT_FOUND');
    if (c.status === 'CANCELLED' && c.cancel_reason === 'auto-fix-expired') throw fail(409, 'FIX_WINDOW_EXPIRED');
    if (c.status !== 'NEED_FIX') throw fail(409, 'INVALID_STATE');
    const deadline = isoOrNull(c.fix_deadline) || (c.need_fix_at ? clock.toIso(clock.addMs(c.need_fix_at, FIX_WINDOW_MS)) : null);
    if (deadline && clock.cmp(clock.now(), deadline) >= 0) throw fail(409, 'FIX_WINDOW_EXPIRED');

    // ไฟล์ใหม่ (ไม่บังคับ)
    const list = (files || []).filter((f) => f && f.buffer);
    if (list.length) {
      const have = caseFiles(c).length;
      if (have + list.length > MAX_FILES_PER_CASE) throw fail(400, 'FILE_COUNT');
      for (const f of list) {
        if (f.size > MAX_FILE_BYTES) throw fail(400, 'FILE_TOO_LARGE');
        const mime = sniffMime(f.buffer);
        if (!mime) throw fail(400, 'FILE_TYPE');
        if ((body.docKey === 'plan' || f.fieldname === 'plan') && mime !== 'application/pdf') throw fail(400, 'PLAN_NOT_PDF');
      }
    }

    const now = clock.nowIso();
    const returnedAt = c.need_fix_at || now;
    const ext = rules.needFixExtension(c.due_at, returnedAt, now); // ใช้ตารางวันหยุด ณ เวลาที่ส่งแก้ (A-42) · B04 อยู่ใน rules
    db.prepare("UPDATE cases SET status = 'IN_REVIEW', due_at = ?, fix_deadline = NULL, updated_at = ? WHERE case_no = ?")
      .run(ext.dueAt, now, c.case_no);
    db.prepare(`UPDATE case_returns SET resubmitted_at = ?, paused_days = ?
        WHERE case_no = ? AND n = (SELECT MAX(n) FROM case_returns WHERE case_no = ?) AND resubmitted_at IS NULL`)
      .run(now, ext.pausedDays, c.case_no, c.case_no);
    for (const f of list) {
      const mime = sniffMime(f.buffer);
      const id = letterId();
      const storage = `${id}${EXT[mime]}`;
      fs.mkdirSync(dbm.UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(dbm.UPLOAD_DIR, storage), f.buffer);
      const docKey = typeof body.docKey === 'string' && /^[a-z-]{1,20}$/.test(body.docKey) ? body.docKey : 'fix';
      db.prepare(`INSERT INTO files (id, draft_id, case_no, doc_key, name, mime, size, storage_name, uploaded_by, is_seed, created_at)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(id, c.case_no, docKey, String(f.originalname || `file${EXT[mime]}`).slice(0, 200), mime, f.size, storage, user.id, now);
    }
    addEvent(c.case_no, now, 'citizen', 'RESUBMIT', 'NEED_FIX', 'IN_REVIEW',
      ext.pausedDays ? `ส่งเอกสารแก้ไขแล้ว (หยุดนับ ${ext.pausedDays} วันทำการ)` : 'ส่งเอกสารแก้ไขแล้ว');
    return { status: 'IN_REVIEW', dueAt: ext.dueAt };
  })();
}

// ───────────────────────── เอกสารดิจิทัล (ตัวสำรอง · B09 แทนได้ด้วย docs.createDocument) ─────────────────────────

let docsModWarned = false;
function docsModule() {
  try {
    return require('./docs');
  } catch (e) {
    if (!docsModWarned && !(e.code === 'MODULE_NOT_FOUND' && /[\\/]docs(\.js)?'/.test(String(e.message)))) {
      console.warn('[officer] โหลด routes/docs.js ไม่ได้ ใช้ตัวออกเอกสารสำรอง:', e.message);
    }
    docsModWarned = true;
    return null;
  }
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
/** วันสุดท้ายที่ใช้ได้ (BR-23): SV-01 ออก + 89 วัน · SV-02/03 วันครบรอบปีถัดไป − 1 วัน (29 ก.พ. → ครบรอบ 28 ก.พ.) */
function validUntilFor(serviceId, issuedAt) {
  const p = clock.parts(issuedAt);
  if (serviceId === 'SV-01') return rules.addDays(p.date, 89);
  const y = p.y + 1;
  const d = p.m === 2 && p.d === 29 && !isLeap(y) ? 28 : p.d;
  return rules.addDays(`${y}-${String(p.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, -1);
}
function newVerifyCode() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let t = 0; t < 50; t++) {
    let s = '';
    for (let i = 0; i < 8; i++) s += A[crypto.randomInt(A.length)];
    if (!db.prepare('SELECT 1 FROM documents WHERE verify_code = ?').get(s)) return s;
  }
  throw new Error('officer: cannot allocate verify code');
}

function createDocument(c, user, now) {
  const docs = docsModule();
  if (docs && typeof docs.createDocument === 'function') {
    const out = docs.createDocument({ db, caseRow: c, issuer: user, now });
    if (out && out.docNo) return { docNo: out.docNo, verifyCode: out.verifyCode };
  }
  const { docSignature } = require('../seed');
  const be = clock.beYear(now);
  const docNo = `DOC-${be}-${String(dbm.nextSeq(`doc:${be}`)).padStart(6, '0')}`;
  const verifyCode = newVerifyCode();
  const signerUsername = c.approved_by || c.issuer || user.username;
  const payload = {
    docNo, caseNo: c.case_no, applicant: c.applicant_name, serviceId: c.service_id,
    issuedAt: now, validUntil: validUntilFor(c.service_id, now), signer: staffName(signerUsername),
  };
  db.prepare(`INSERT INTO documents (doc_no, case_no, verify_code, service_id, applicant_masked, issued_at, valid_until, signer,
      signer_username, payload, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(docNo, c.case_no, verifyCode, c.service_id, pii.maskName(c.applicant_name), now, payload.validUntil, payload.signer,
      signerUsername, JSON.stringify(payload), docSignature(payload));
  return { docNo, verifyCode };
}

// ───────────────────────── JSON ─────────────────────────

/** CONTRACT 6.7 · เจ้าหน้าที่/หัวหน้า: idMasked เท่านั้น (ห้าม idNo) · ประชาชนเจ้าของ: idNo แทน idMasked */
function caseJson(c, viewer, hol) {
  const doc = docOf(c.case_no);
  const out = {
    caseNo: c.case_no,
    serviceId: c.service_id,
    serviceName: c.service_name || format.SERVICE_TH[c.service_id] || '',
    status: c.status,
    step: stepOf(c),
    fee: c.fee,
    paidAt: isoOrNull(c.paid_at),
    dueAt: isoOrNull(c.due_at),
    slaLevel: levelOf(c, hol),
    owner: c.owner || null,
    returnCount: c.return_count || 0,
    closedAt: c.status === 'COMPLETED' || c.status === 'REJECTED' ? isoOrNull(c.closed_at) : null,
    applicantName: c.applicant_name,
  };
  if (viewer && viewer.role === 'citizen') out.idNo = fullIdOf(c);
  else out.idMasked = idMaskedOf(c);
  Object.assign(out, {
    fixDeadline: c.status === 'NEED_FIX' ? isoOrNull(c.fix_deadline) : null,
    docNo: doc ? doc.doc_no : null,
    verifyCode: doc ? doc.verify_code : null,
    dept: c.dept || null,
    issuer: c.issuer || null,
    cancelledAt: c.status === 'CANCELLED' ? isoOrNull(c.cancelled_at) : null,
    receiptNo: c.receipt_no || null,
  });
  return out;
}

function queueItemJson(c, hol) {
  const item = {
    caseNo: c.case_no, serviceId: c.service_id, applicantName: c.applicant_name, idMasked: idMaskedOf(c),
    status: c.status, step: stepOf(c), owner: c.owner || null, dueAt: isoOrNull(c.due_at), slaLevel: levelOf(c, hol),
  };
  if (isBug('B09')) item.idNo = fullIdOf(c); // B09: API ส่งเลขบัตรเต็ม (จอยังปิดบัง)
  return item;
}

function fileJson(f) {
  return { fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size, mime: f.mime };
}

// ───────────────────────── คิว ─────────────────────────

/** officer = แผนกตัวเอง · head = ทะเบียน + โยธา · เรียง BR-16 (กำหนดเสร็จ → เลขคำขอ) */
function queueRows(user, filter) {
  const depts = isHead(user) ? ['registry', 'works'] : (user.dept ? [user.dept] : []);
  if (!depts.length) return [];
  const rows = db.prepare(`${CASE_SQL} WHERE c.status IN (${QUEUE_STATUSES.map(() => '?').join(',')})
      AND c.dept IN (${depts.map(() => '?').join(',')})`).all(...QUEUE_STATUSES, ...depts);
  let out = rows;
  if (filter === 'unclaimed') out = rows.filter((c) => (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW') && !c.owner);
  else if (filter === 'mine') out = rows.filter((c) => c.status === 'IN_REVIEW' && c.owner === user.username);
  return out.sort(cmpQueue);
}

function approvalRows() {
  return db.prepare(`${CASE_SQL} WHERE c.status = 'PENDING_APPROVAL'`).all().sort(cmpQueue);
}

// ───────────────────────── HTML ─────────────────────────

const PAGE_STYLE = `<style>
.b07 h1{font-size:1.5rem;margin:.5rem 0 1rem}
.b07 h2{font-size:1.2rem;margin:1.25rem 0 .5rem}
.b07 .toolbar{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;align-items:flex-end;margin:.5rem 0 1rem}
.b07 .toolbar form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end;margin:0}
.b07 .toolbar label{margin:0}
.b07 .workload{margin:0;font-size:1.05rem}
.b07 .table-wrap{width:100%;overflow-x:auto;background:#fff;border:1px solid #d0d5dd;border-radius:8px}
.b07 table{min-width:860px}
.b07 th{background:#eef2f7}
.b07 td form{margin:0}
.b07 .badge{display:inline-block;padding:.05rem .55rem;border-radius:1rem;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.b07 .st{color:#1f2937;background:#eef0f3}
.b07 .lv-normal{color:#11613a;background:#e8f5ec}
.b07 .lv-near{color:#6b3d00;background:#fff4d6}
.b07 .lv-overdue{color:#a40e0e;background:#fdecec}
.b07 .lv-paused,.b07 .lv-closed{color:#374151;background:#eef0f3}
.b07 .case-info{margin:0;background:#fff;border:1px solid #d0d5dd;border-radius:8px;padding:.5rem 1rem;max-width:760px}
.b07 .case-info>div{display:flex;flex-wrap:wrap;gap:.25rem 1rem;padding:.35rem 0;border-bottom:1px solid #e5e7eb}
.b07 .case-info>div:last-child{border-bottom:0}
.b07 .case-info dt{font-weight:600;min-width:10rem}
.b07 .case-info dd{margin:0}
.b07 .panel{background:#fff;border:1px solid #d0d5dd;border-radius:8px;padding:.75rem 1rem;margin:.75rem 0;max-width:760px}
.b07 .panel h3{font-size:1.05rem;margin:0 0 .5rem}
.b07 .panel textarea,.b07 .panel input[type=text]{width:100%;max-width:100%}
.b07 .panel textarea{min-height:4.5rem}
.b07 .row-actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.5rem}
.b07 .field-error{color:#a40e0e;font-weight:600;margin:.25rem 0}
.b07 .full-id{font-weight:700;margin-left:.5rem}
.b07 .muted{color:#3d4451}
.b07 .timeline{padding-left:1.25rem}
.b07 .timeline li{margin:.35rem 0}
.b07 .doc-list{padding-left:1.25rem}
</style>`;

function statusBadge(status, testid = 'case-status') {
  return html`<span class="badge st" data-testid="${testid}" data-status="${status}">${format.STATUS_TH[status] || status}</span>`;
}
function levelBadge(level, testid = 'sla-level') {
  if (!level) return html`<span class="badge st" data-testid="${testid}" data-level="">–</span>`;
  return html`<span class="badge lv-${level}" data-testid="${testid}" data-level="${level}">${format.LEVEL_TH[level] || level}</span>`;
}
function timeEl(iso, testid) {
  const v = isoOrNull(iso);
  if (!v) return html`<span data-testid="${testid}">–</span>`;
  return html`<time data-testid="${testid}" data-iso="${v}" datetime="${v}">${clock.formatThai(v)}</time>`;
}
function caseUrl(caseNo) {
  return `/officer/cases/${encodeURIComponent(caseNo)}`;
}
function queueUrl(filter) {
  return filter && filter !== 'all' ? `/officer/queue?filter=${encodeURIComponent(filter)}` : '/officer/queue';
}

/** flash ข้ามการ redirect (เก็บใน session · ไม่มีข้อมูลส่วนบุคคล) */
function setFlash(req, f) {
  session.setData(req, { b07flash: f });
}
function takeFlash(req) {
  const f = req.session && req.session.data && req.session.data.b07flash;
  if (f) session.setData(req, { b07flash: null });
  return f || {};
}

function renderQueue(req, res, filter, opts = {}) {
  const u = req.user;
  const hol = rules.loadHolidays(db);
  const flash = opts.flash || {};
  const rows = queueRows(u, filter);
  const officer = isOfficer(u);
  const title = isHead(u) ? 'คิวงานทุกแผนก (อ่านอย่างเดียว)' : `คิวงาน${DEPT_TH[u.dept] ? ` ${DEPT_TH[u.dept]}` : ''}`;

  const trs = rows.map((c) => {
    const lv = levelOf(c, hol);
    return html`<tr data-testid="queue-row" data-case-no="${c.case_no}" data-owner="${c.owner || ''}" data-status="${c.status}" data-sla-level="${lv || ''}">
<td data-testid="row-case-no"><a href="${caseUrl(c.case_no)}">${c.case_no}</a></td>
<td data-testid="row-service">${serviceLabel(c)}${c.service_id === 'SV-03' ? html`<br><small>${STEP_TH[stepOf(c)] || ''}</small>` : ''}</td>
<td data-testid="row-applicant">${c.applicant_name}</td>
<td data-testid="row-id-masked">${idMaskedOf(c)}</td>
<td>${statusBadge(c.status, 'row-status')}</td>
<td>${timeEl(c.due_at, 'row-due')}</td>
<td>${levelBadge(lv, 'row-sla-level')}</td>
<td data-testid="row-owner">${c.owner || ''}</td>
<td>${canClaim(u, c) ? html`<form method="post" action="${caseUrl(c.case_no)}/claim"><input type="hidden" name="back" value="queue"><input type="hidden" name="filter" value="${filter}"><button type="submit" data-testid="claim-btn">รับเรื่อง</button></form>` : ''}</td>
</tr>`;
  });

  const options = FILTERS.map((f) => html`<option value="${f}"${raw(f === filter ? ' selected' : '')}>${FILTER_TH[f]}</option>`);
  const body = html`${raw(PAGE_STYLE)}<div class="b07">
<h1>${title}</h1>
<div class="toolbar">
${officer ? html`<p class="workload">งานในมือของฉัน: <strong data-testid="workload-count">${workloadOf(u.username)}</strong> / ${MAX_WORKLOAD} เรื่อง</p>` : ''}
<form method="get" action="/officer/queue">
<label for="queue-filter">แสดง</label>
<select id="queue-filter" name="filter" data-testid="queue-filter" onchange="this.form.submit()">${options}</select>
<button type="submit" class="secondary">กรอง</button>
</form>
</div>
<div class="table-wrap" role="region" aria-label="ตารางคิวงาน" tabindex="0">
<table data-testid="queue-table">
<caption class="visually-hidden">คิวงาน เรียงตามกำหนดเสร็จเร็วสุดก่อน (${FILTER_TH[filter]} ${rows.length} รายการ)</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">เลขบัตรประชาชน</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ผู้ถือเรื่อง</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>${trs}</tbody>
</table></div>
${rows.length ? '' : html`<p data-testid="queue-empty" role="status">ไม่มีงานในคิว</p>`}
</div>`;
  return auth.sendPage(req, res, { title: 'คิวงาน', body, status: opts.status || 200, error: opts.error || null, success: flash.ok || opts.success || null });
}

function renderApprovals(req, res) {
  const hol = rules.loadHolidays(db);
  const flash = takeFlash(req);
  const rows = approvalRows();
  const trs = rows.map((c) => html`<tr data-testid="approval-row" data-case-no="${c.case_no}">
<td data-testid="row-case-no">${c.case_no}</td>
<td data-testid="row-service">${serviceLabel(c)}</td>
<td data-testid="row-applicant">${c.applicant_name}</td>
<td>${timeEl(c.due_at, 'row-due')}</td>
<td>${levelBadge(levelOf(c, hol), 'row-sla-level')}</td>
<td><a data-testid="approval-open" href="${caseUrl(c.case_no)}">เปิดคำขอ</a></td>
</tr>`);
  const body = html`${raw(PAGE_STYLE)}<div class="b07">
<h1>รายการรออนุมัติ</h1>
${rows.length ? html`<div class="table-wrap" role="region" aria-label="ตารางรายการรออนุมัติ" tabindex="0">
<table data-testid="approval-table">
<caption class="visually-hidden">คำขอที่รออนุมัติ เรียงตามกำหนดเสร็จเร็วสุดก่อน (${rows.length} รายการ)</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>${trs}</tbody></table></div>` : html`<p data-testid="approvals-empty" role="status">ไม่มีคำขอรออนุมัติ</p>`}
</div>`;
  return auth.sendPage(req, res, { title: 'รออนุมัติ', body, success: flash.ok || null });
}

/** หน้า /officer/cases/:caseNo · opts = {status, error, success, fieldErrors:{return,reject,unmask}, values:{...}, showFullId} */
function renderCase(req, res, caseNo, opts = {}) {
  const u = req.user;
  const c = loadCase(caseNo);
  if (!c) return auth.notFoundPage(req, res);
  const hol = rules.loadHolidays(db);
  const lv = levelOf(c, hol);
  const doc = docOf(c.case_no);
  const fe = opts.fieldErrors || {};
  const val = opts.values || {};
  const step = stepOf(c);
  const closed = c.status === 'COMPLETED' || c.status === 'REJECTED';
  const url = caseUrl(c.case_no);
  const events = db.prepare('SELECT * FROM case_events WHERE case_no = ? ORDER BY time, id').all(c.case_no);
  const files = canViewFiles(u, c) ? caseFiles(c) : null;
  const labels = docLabels(c.service_id);

  const info = html`<dl class="case-info">
<div><dt>สถานะ</dt><dd>${statusBadge(c.status)}</dd></div>
<div><dt>บริการ</dt><dd data-testid="case-service">${serviceLabel(c)}</dd></div>
${step ? html`<div><dt>ขั้นตอน</dt><dd data-testid="case-step">${STEP_TH[step]}</dd></div>` : ''}
<div><dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${format.baht(c.fee)}</dd></div>
<div><dt>ผู้ยื่น</dt><dd data-testid="applicant-name">${c.applicant_name}</dd></div>
<div><dt>เลขบัตรประชาชน</dt><dd><span data-testid="applicant-id">${idMaskedOf(c)}</span>${opts.showFullId ? html`<span class="full-id">เลขเต็ม: <span data-testid="full-id">${pii.formatIdNo(fullIdOf(c))}</span></span>` : ''}</dd></div>
<div><dt>ชำระเงินเมื่อ</dt><dd>${timeEl(c.paid_at, 'paid-at')}</dd></div>
<div><dt>กำหนดเสร็จ</dt><dd>${timeEl(c.due_at, 'sla-due')}</dd></div>
<div><dt>ระดับเตือน</dt><dd>${levelBadge(lv)}</dd></div>
${closed ? html`<div><dt>ปิดงานเมื่อ</dt><dd>${timeEl(c.closed_at, 'closed-at')}</dd></div>` : ''}
${c.status === 'CANCELLED' ? html`<div><dt>ยกเลิกเมื่อ</dt><dd>${timeEl(c.cancelled_at, 'cancelled-at')}</dd></div>` : ''}
<div><dt>ผู้ถือเรื่อง</dt><dd data-testid="case-owner">${c.owner || NO_OWNER_TH}</dd></div>
<div><dt>อยู่ที่</dt><dd>${c.dept ? (DEPT_TH[c.dept] || c.dept) : 'ปิดแล้ว'}</dd></div>
<div><dt>ตีกลับแล้ว</dt><dd><span data-testid="return-count">${c.return_count || 0}</span> / ${MAX_RETURNS} ครั้ง</dd></div>
${c.status === 'NEED_FIX' ? html`<div><dt>เส้นตายแก้ไขของประชาชน</dt><dd>${timeEl(c.fix_deadline, 'fix-deadline')}</dd></div>` : ''}
${c.issuer ? html`<div><dt>ผู้ออกเอกสาร</dt><dd data-testid="case-issuer">${c.issuer}</dd></div>` : ''}
${doc ? html`<div><dt>เลขเอกสาร</dt><dd data-testid="doc-no">${doc.doc_no}</dd></div>
<div><dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${doc.verify_code}</dd></div>
<div><dt>QR ตรวจสอบเอกสาร</dt><dd><a data-testid="doc-qr" data-url="${`${BASE_URL}/verify/${doc.verify_code}`}" href="/verify/${doc.verify_code}">${`${BASE_URL}/verify/${doc.verify_code}`}</a></dd></div>` : ''}
</dl>`;

  // ปุ่มดำเนินการ (ไม่ render เมื่อไม่มีสิทธิ์ · CONTRACT 0.5)
  const panels = [];
  if (canClaim(u, c)) {
    panels.push(html`<div class="panel"><form method="post" action="${url}/claim"><input type="hidden" name="back" value="case"><button type="submit" data-testid="claim-btn">รับเรื่อง</button></form></div>`);
  }
  if (canDecide(u, c)) {
    panels.push(html`<div class="panel"><h3>ผลพิจารณา</h3>
<form method="post" action="${url}/approve"><button type="submit" data-testid="approve-btn">อนุมัติ</button></form>
<div class="row-actions"><button type="button" class="secondary" data-testid="reject-btn" onclick="document.getElementById('reject-reason').focus()">ไม่อนุมัติ</button></div>
<form method="post" action="${url}/reject" novalidate>
<label for="reject-reason">เหตุผลที่ไม่อนุมัติ (อย่างน้อย ${MIN_REASON_CHARS} ตัวอักษร)</label>
<textarea id="reject-reason" name="reason" data-testid="reject-reason"${raw(fe.reject ? ' aria-describedby="reject-reason-error" aria-invalid="true"' : '')}>${val.reject || ''}</textarea>
${fe.reject ? html`<p class="field-error" id="reject-reason-error" data-testid="reject-reason-error" role="alert">${fe.reject}</p>` : ''}
<div class="row-actions"><button type="submit" data-testid="reject-submit">ยืนยันไม่อนุมัติ</button></div>
</form></div>`);
  }
  if (canForward(u, c)) {
    const target = c.service_id === 'SV-03' && step === 1 ? 'ฝ่ายโยธา (ขั้นตอน 2/3)' : 'หัวหน้าฝ่ายอนุมัติ';
    panels.push(html`<div class="panel"><h3>ส่งต่อ</h3>
<form method="post" action="${url}/forward" novalidate>
<p class="muted">ระบบส่งต่อตามเส้นทางของบริการอัตโนมัติ: ${target}</p>
<label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
<textarea id="forward-note" name="note" data-testid="forward-note">${val.forward || ''}</textarea>
<div class="row-actions"><button type="submit" data-testid="forward-btn">ผ่าน/ส่งต่อ</button></div>
</form></div>`);
  }
  if (canReturn(u, c)) {
    panels.push(html`<div class="panel"><h3>ตีกลับให้ประชาชนแก้ไข</h3>
<div class="row-actions"><button type="button" class="secondary" data-testid="return-btn" onclick="document.getElementById('return-reason').focus()">ตีกลับ</button>
<span class="muted">ตีกลับได้อีก ${Math.max(0, MAX_RETURNS - (c.return_count || 0))} ครั้ง · ประชาชนมีเวลาแก้ไข 7 วัน (168 ชั่วโมง)</span></div>
<form method="post" action="${url}/return" novalidate>
<label for="return-reason">เหตุผลที่ตีกลับ (อย่างน้อย ${MIN_REASON_CHARS} ตัวอักษร)</label>
<textarea id="return-reason" name="reason" data-testid="return-reason"${raw(fe.return ? ' aria-describedby="return-reason-error" aria-invalid="true"' : '')}>${val.return || ''}</textarea>
${fe.return ? html`<p class="field-error" id="return-reason-error" data-testid="return-reason-error" role="alert">${fe.return}</p>` : ''}
<div class="row-actions"><button type="submit" data-testid="return-submit">ยืนยันตีกลับ</button></div>
</form></div>`);
  }
  if (canIssue(u, c)) {
    panels.push(html`<div class="panel"><form method="post" action="${url}/issue"><button type="submit" data-testid="issue-btn">ออกเอกสาร</button></form></div>`);
  }

  const unmask = html`<div class="panel"><h3>แสดงเลขบัตรประชาชนเต็ม</h3>
<p class="muted">ต้องระบุเหตุผล ระบบบันทึกการเปิดดูใน Audit Trail</p>
<div class="row-actions"><button type="button" class="secondary" data-testid="show-full-id-btn" onclick="document.getElementById('unmask-reason').focus()">แสดงเลขเต็ม</button></div>
<form method="post" action="${url}/unmask" novalidate>
<label for="unmask-reason">เหตุผลที่ขอดูเลขบัตรเต็ม</label>
<input type="text" id="unmask-reason" name="reason" data-testid="unmask-reason" autocomplete="off" value="${val.unmask || ''}"${raw(fe.unmask ? ' aria-describedby="unmask-error" aria-invalid="true"' : '')}>
${fe.unmask ? html`<p class="field-error" id="unmask-error" data-testid="unmask-error" role="alert">${fe.unmask}</p>` : ''}
<div class="row-actions"><button type="submit" data-testid="unmask-submit">ยืนยัน</button></div>
</form></div>`;

  const docsSection = files === null
    ? html`<p class="muted" data-testid="docs-forbidden">ไม่มีสิทธิ์เปิดไฟล์แนบของคำขอนี้ (เปิดได้เฉพาะแผนกที่ถือเรื่องหรือเคยผ่าน)</p>`
    : files.length
      ? html`<ul class="doc-list">${files.map((f) => html`<li data-testid="doc-item" data-name="${f.name}" data-file-id="${f.id}">${labels[f.doc_key] || f.doc_key}: ${f.name} (${Number(f.size).toLocaleString('en-US')} ไบต์) <a data-testid="doc-download-link" href="/api/files/${encodeURIComponent(f.id)}">เปิด/ดาวน์โหลด<span class="visually-hidden"> ${f.name}</span></a></li>`)}</ul>`
      : html`<p class="muted">ไม่มีไฟล์แนบ</p>`;

  const timeline = html`<ol class="timeline" data-testid="case-timeline">${events.map((e) => {
    const t = isoOrNull(e.time);
    return html`<li data-testid="timeline-item" data-iso="${t || ''}" data-event="${e.event}"><time datetime="${t || ''}">${t ? clock.formatThai(t) : ''}</time> · ${EVENT_TH[e.event] || e.event}${e.actor && e.actor !== 'citizen' && e.actor !== 'system' ? ` โดย ${e.actor}` : ''}${e.to_status ? ` → ${format.STATUS_TH[e.to_status] || e.to_status}` : ''}${e.note ? html` <span class="muted">(${e.note})</span>` : ''}</li>`;
  })}</ol>`;

  const body = html`${raw(PAGE_STYLE)}<div class="b07">
<p><a href="${isHead(u) && c.status === 'PENDING_APPROVAL' ? '/head/approvals' : '/officer/queue'}">← กลับ${isHead(u) && c.status === 'PENDING_APPROVAL' ? 'รายการรออนุมัติ' : 'คิวงาน'}</a></p>
<h1>คำขอเลขที่ <span data-testid="case-no">${c.case_no}</span></h1>
${info}
${panels.length ? html`<h2>ดำเนินการ</h2>${panels}` : ''}
<h2>ข้อมูลส่วนบุคคล</h2>
${unmask}
<h2>เอกสารแนบ</h2>
${docsSection}
<h2>ไทม์ไลน์</h2>
${timeline}
</div>`;
  return auth.sendPage(req, res, {
    title: `คำขอ ${c.case_no}`, body, status: opts.status || 200, error: opts.error || null, success: opts.success || null,
  });
}

// ───────────────────────── ตัวช่วย route ─────────────────────────

function apiAction(fn) {
  return (req, res, next) => {
    try {
      return res.status(200).json(fn(req));
    } catch (e) {
      if (e instanceof ActionError) return auth.apiError(res, e.status, e.code, e.message);
      return next(e);
    }
  };
}

function sendStoredFile(res, f) {
  const p = path.join(dbm.UPLOAD_DIR, path.basename(String(f.storage_name || '')));
  if (!f.storage_name || !fs.existsSync(p)) return auth.apiError(res, 404, 'NOT_FOUND', MSG.FILE_NOT_FOUND);
  const ascii = String(f.name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set('Content-Type', f.mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`);
  res.set('X-Content-Type-Options', 'nosniff');
  return res.status(200).send(fs.readFileSync(p));
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 + 1024, files: 10 } });
function maybeMultipart(req, res, next) {
  if (req.is('multipart/form-data')) return upload.any()(req, res, next);
  return next();
}

// ───────────────────────── register ─────────────────────────

function register(app, ctx = {}) {
  if (ctx.BASE_URL) BASE_URL = String(ctx.BASE_URL).replace(/\/+$/, '');
  const h = ctx.hooks || hooks;
  h.onEveryRequest(() => autoCancelExpired(), { order: 10 }); // CONTRACT 0.7 · A-46

  const r = express.Router();

  // ── หน้า ──
  r.get('/officer', auth.requirePage('officer', 'head'), (req, res) => res.redirect(302, '/officer/queue'));
  r.get('/head', auth.requirePage('head'), (req, res) => res.redirect(302, '/head/approvals'));

  r.get('/officer/queue', auth.requirePage('officer', 'head'), (req, res) => {
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    return renderQueue(req, res, filter, { flash: takeFlash(req) });
  });

  r.get('/head/approvals', auth.requirePage('head'), renderApprovals);

  r.get('/officer/cases/:caseNo', auth.requirePage('officer', 'head'), (req, res) => {
    const flash = takeFlash(req);
    const caseNo = req.params.caseNo;
    return renderCase(req, res, caseNo, { success: flash.ok || null, showFullId: flash.unmask === caseNo });
  });

  r.post('/officer/cases/:caseNo/:action(claim|return|forward|approve|reject|issue|unmask)', auth.requirePage('officer', 'head'), (req, res, next) => {
    const { caseNo, action } = req.params;
    const b = req.body || {};
    const back = b.back === 'queue' ? 'queue' : 'case';
    const filter = FILTERS.includes(b.filter) ? b.filter : 'all';
    try {
      let ok;
      switch (action) {
        case 'claim': claimCase(req.user, caseNo); ok = `รับเรื่อง ${caseNo} แล้ว`; break;
        case 'return': returnCase(req.user, caseNo, b.reason); ok = 'ตีกลับคำขอให้ประชาชนแก้ไขแล้ว'; break;
        case 'forward': forwardCase(req.user, caseNo, b.note); ok = 'ส่งต่อคำขอแล้ว'; break;
        case 'approve': approveCase(req.user, caseNo); ok = 'อนุมัติคำขอแล้ว'; break;
        case 'reject': rejectCase(req.user, caseNo, b.reason); ok = 'บันทึกผลไม่อนุมัติแล้ว'; break;
        case 'issue': { const d = issueCase(req.user, caseNo); ok = `ออกเอกสาร ${d.docNo} แล้ว`; break; }
        case 'unmask':
          unmaskCase(req.user, caseNo, b.reason);
          setFlash(req, { unmask: caseNo, ok: 'แสดงเลขบัตรเต็มในหน้านี้ครั้งเดียว (โหลดหน้าใหม่จะปิดบังอีกครั้ง)' });
          return res.redirect(303, caseUrl(caseNo));
        default: return next();
      }
      setFlash(req, { ok });
      return res.redirect(303, back === 'queue' ? queueUrl(filter) : caseUrl(caseNo));
    } catch (e) {
      if (!(e instanceof ActionError)) return next(e);
      if (e.code === 'NOT_FOUND') return auth.notFoundPage(req, res);
      if (back === 'queue') return renderQueue(req, res, filter, { status: e.status, error: e.message });
      const values = { [action]: typeof b.reason === 'string' ? b.reason : '' };
      if (action === 'forward') values.forward = typeof b.note === 'string' ? b.note : '';
      return renderCase(req, res, caseNo, {
        status: e.status,
        error: e.field ? null : e.message,
        fieldErrors: e.field ? { [e.field]: e.message } : {},
        values,
      });
    }
  });

  // ── API เจ้าหน้าที่ / หัวหน้า ──
  r.get('/api/officer/queue', auth.requireApi('officer', 'head'), (req, res) => {
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const hol = rules.loadHolidays(db);
    const out = { filter, items: queueRows(req.user, filter).map((c) => queueItemJson(c, hol)) };
    if (isOfficer(req.user)) out.workload = workloadOf(req.user.username);
    res.json(out);
  });

  r.post('/api/officer/cases/:caseNo/claim', auth.requireApi('officer'), apiAction((req) => claimCase(req.user, req.params.caseNo)));
  r.post('/api/officer/cases/:caseNo/return', auth.requireApi('officer'),
    apiAction((req) => returnCase(req.user, req.params.caseNo, (req.body || {}).reason)));
  r.post('/api/officer/cases/:caseNo/forward', auth.requireApi('officer'),
    apiAction((req) => forwardCase(req.user, req.params.caseNo, (req.body || {}).note)));
  r.post('/api/officer/cases/:caseNo/issue', auth.requireApi('officer'), apiAction((req) => issueCase(req.user, req.params.caseNo)));
  r.post('/api/officer/cases/:caseNo/unmask', auth.requireApi('officer', 'head'),
    apiAction((req) => unmaskCase(req.user, req.params.caseNo, (req.body || {}).reason)));
  r.post('/api/cases/:caseNo/approve', auth.requireApi('officer', 'head'), apiAction((req) => approveCase(req.user, req.params.caseNo)));
  r.post('/api/cases/:caseNo/reject', auth.requireApi('officer', 'head'),
    apiAction((req) => rejectCase(req.user, req.params.caseNo, (req.body || {}).reason)));

  // ── คำขอ (CONTRACT 6.7) · ประชาชนเจ้าของ + เจ้าหน้าที่/หัวหน้า ──
  r.get('/api/cases/:caseNo', auth.requireApi('citizen', 'officer', 'head'), (req, res) => {
    const c = loadCase(req.params.caseNo);
    const u = req.user;
    if (!c || (u.role === 'citizen' && c.user_id !== u.id && !isBug('B06'))) return auth.apiError(res, 404, 'NOT_FOUND', MSG.NOT_FOUND);
    return res.json(caseJson(c, u));
  });

  // ── ไฟล์แนบ (BR-29) ──
  r.get('/api/cases/:caseNo/files', auth.requireApi('citizen', 'officer', 'head'), (req, res) => {
    const c = loadCase(req.params.caseNo);
    const u = req.user;
    if (!c || (u.role === 'citizen' && c.user_id !== u.id)) return auth.apiError(res, 404, 'NOT_FOUND', MSG.NOT_FOUND);
    if (!canViewFiles(u, c)) return auth.apiError(res, 403, 'FORBIDDEN', MSG.FORBIDDEN);
    return res.json({ items: caseFiles(c).map(fileJson) });
  });

  r.get('/api/files/:fileId', auth.requireApi('citizen', 'officer', 'head'), (req, res) => {
    const u = req.user;
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(String(req.params.fileId));
    if (!f) return auth.apiError(res, 404, 'NOT_FOUND', MSG.FILE_NOT_FOUND);
    let caseNo = f.case_no;
    if (!caseNo && f.draft_id) {
      const d = db.prepare('SELECT case_no FROM drafts WHERE id = ?').get(f.draft_id);
      const viaCase = db.prepare('SELECT case_no FROM cases WHERE draft_id = ?').get(f.draft_id);
      caseNo = (d && d.case_no) || (viaCase && viaCase.case_no) || null;
    }
    const c = caseNo ? loadCase(caseNo) : null;
    if (!c) {
      // ไฟล์ของร่างที่ยังไม่มีเลขคำขอ: เจ้าของร่างเท่านั้น
      const d = f.draft_id ? db.prepare('SELECT user_id, status FROM drafts WHERE id = ?').get(f.draft_id) : null;
      if (u.role === 'citizen' && d && d.user_id === u.id && d.status !== 'DELETED') return sendStoredFile(res, f);
      return auth.apiError(res, 404, 'NOT_FOUND', MSG.FILE_NOT_FOUND);
    }
    if (u.role === 'citizen' && c.user_id !== u.id) return auth.apiError(res, 404, 'NOT_FOUND', MSG.FILE_NOT_FOUND);
    if (!canViewFiles(u, c)) return auth.apiError(res, 403, 'FORBIDDEN', MSG.FORBIDDEN);
    return sendStoredFile(res, f);
  });

  // ── ส่งแก้ไข (สำรอง: ถ้า citizen.js ประกาศเส้นนี้ก่อน ตัวนั้นทำงานแทน) ──
  r.post('/api/cases/:caseNo/resubmit', auth.requireApi('citizen'), maybeMultipart,
    apiAction((req) => resubmitCase(req.user, req.params.caseNo, req.files || [], req.body || {})));

  app.use(r);
}

module.exports = register;
module.exports.helpers = {
  MSG, MAX_WORKLOAD, MAX_RETURNS, MIN_REASON_CHARS, FIX_WINDOW_MS, STEP_TH, DEPT_TH, EVENT_TH, ActionError,
  loadCase, caseJson, caseFiles, fileJson, queueRows, approvalRows, workloadOf, idMaskedOf, stepOf,
  canClaim, canReturn, canForward, canDecide, canIssue, canViewFiles,
  claimCase, returnCase, forwardCase, approveCase, rejectCase, issueCase, unmaskCase, resubmitCase,
  autoCancelExpired, validUntilFor,
};
