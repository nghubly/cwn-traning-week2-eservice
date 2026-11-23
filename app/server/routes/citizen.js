'use strict';
/**
 * B05 · ประชาชน: ยื่นคำขอ (wizard 3 ขั้น) · ร่าง · แนบไฟล์ · ยกเลิก · ส่งแก้ไข · ดูคำขอของตัวเอง
 * REQUIREMENTS FR-04..07 FR-09 · BR-06..08 BR-13 BR-20 BR-22 · CONTRACT §2.4–2.6 §4.3 §5 §6.2 · DECISIONS §4 §5
 * BUG_MODE: B02 (ไฟล์ 5,242,880 ไบต์พอดีถูกปฏิเสธ) · B06 (ประชาชนเปิดคำขอคนอื่นได้ทั้งหน้าและ GET API)
 *
 * ── หน้า ──
 *   GET  /citizen                          รายการคำขอ + ร่าง + ปุ่มเริ่มบริการ
 *   GET  /citizen/new/:service[?draft=DR-x] wizard 1/3 กรอกข้อมูล → 2/3 แนบเอกสาร → 3/3 ชำระเงิน
 *                                           (ขั้น 3 เรียก API ของ B06: POST /api/drafts/:id/payment · GET /api/payments/:ref)
 *   GET  /citizen/cases/:caseNo            รายละเอียดคำขอ (ของคนอื่น/ไม่มี → 404 not-found-msg)
 *   POST /citizen/cases/:caseNo/cancel     ฟอร์มยืนยันยกเลิก → 303 กลับหน้าคำขอ
 *   POST /citizen/cases/:caseNo/resubmit   ฟอร์มส่งแก้ไข (multipart ไฟล์ไม่บังคับ) → 303
 *
 * ── API (citizen เท่านั้น ยกเว้นระบุ) ──
 *   GET    /api/fee-quote?serviceId=&qty=&areaSqm=   คำนวณค่าธรรมเนียมจาก rules.js (หน้า wizard ใช้ · ไม่สร้างข้อมูล)
 *   POST   /api/drafts                    201 {draftId, fee, ...} · 400 INVALID_QTY/INVALID_AREA/AREA_TOO_LARGE
 *   GET    /api/drafts                    {items:[{draftId, serviceId, status, fee}]} (DRAFT + PENDING_PAYMENT)
 *   GET    /api/drafts/:id                รายละเอียด + files + missing + payment ล่าสุด · ของคนอื่น → 404
 *   PUT    /api/drafts/:id                แก้ qty/areaSqm (เฉพาะ DRAFT)
 *   DELETE /api/drafts/:id                204 (ลบร่าง + ไฟล์ + QR ทั้งหมด → ref เดิม 404) · ชำระแล้ว 409 INVALID_STATE
 *   POST   /api/drafts/:id/files          multipart file + docKey → 201 · 400 FILE_TOO_LARGE/FILE_TYPE/FILE_COUNT/PLAN_NOT_PDF
 *   DELETE /api/drafts/:id/files/:fileId  204
 *   GET    /api/cases                     {items:[{caseNo, serviceId, status, dueAt, slaLevel}]} ของฉัน
 *   GET    /api/cases/:caseNo             citizen เจ้าของ (idNo เต็ม) · officer/head (idMasked) · อื่น 403
 *   POST   /api/cases/:caseNo/cancel      200 {status:"CANCELLED"} · 409 CANNOT_CANCEL
 *   POST   /api/cases/:caseNo/resubmit    200 {status:"IN_REVIEW", dueAt} · 409 FIX_WINDOW_EXPIRED / INVALID_STATE
 *
 * ยกเลิกอัตโนมัติ NEED_FIX เลย 168 ชม. (A-46): มี hook สำรอง (order 15) แบบ idempotent
 * (UPDATE … WHERE status='NEED_FIX') ถ้าบล็อกเจ้าหน้าที่ทำไปก่อนแล้ว hook นี้จะไม่ทำซ้ำ
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { db, UPLOAD_DIR } = require('../db');
const clock = require('../lib/clock');
const bug = require('../lib/bugmode');
const pii = require('../lib/pii');
const format = require('../lib/format');
const rules = require('../lib/rules');
const { html, raw } = require('../lib/html');
const auth = require('./auth');

// ───────────────────────── ค่าคงที่ของกฎ ─────────────────────────
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5,242,880 (A-10 · รวมค่านี้)
const MAX_FILES = 5;                     // ต่อคำขอ รวมทุกช่อง (A-49)
const FIX_WINDOW_MS = 168 * 3600 * 1000; // 168 ชม. (A-21)
const SERVICES = ['SV-01', 'SV-02', 'SV-03'];

const MSG = {
  NOT_FOUND: 'ไม่พบคำขอ',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  NO_REFUND: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
  INVALID_SERVICE: 'ไม่พบบริการ',
  INVALID_DOC_KEY: 'ช่องเอกสารไม่ถูกต้อง',
  FILE_REQUIRED: 'กรุณาเลือกไฟล์',
};

// เอกสารตาม CONTRACT 4.3 (ใช้เมื่อตาราง service_docs ว่าง)
const DOCS_FALLBACK = {
  'SV-01': [['id-card', 'บัตรประชาชน', 1, 0]],
  'SV-02': [['id-card', 'บัตรประชาชน', 1, 0], ['map', 'แผนที่ตั้ง', 1, 0], ['site-photo', 'ภาพสถานที่', 0, 0]],
  'SV-03': [['id-card', 'บัตรประชาชน', 1, 0], ['plan', 'แบบแปลน', 1, 1], ['deed', 'โฉนด', 1, 0]],
};
const EXTRA_DOC = { key: 'extra', label: 'เอกสารเพิ่มเติม', required: false, pdfOnly: false };

const STEP_TH = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };
const EVENT_TH = {
  SUBMIT: 'ชำระเงินและส่งคำขอ', CLAIM: 'เจ้าหน้าที่รับเรื่อง', RETURN: 'ตีกลับให้แก้ไขเอกสาร', RESUBMIT: 'ส่งเอกสารแก้ไขแล้ว',
  FORWARD: 'ส่งต่อขั้นถัดไป', APPROVE: 'อนุมัติ', REJECT: 'ไม่อนุมัติ', ISSUE: 'ออกเอกสาร', CANCEL: 'ประชาชนยกเลิกคำขอ',
  AUTO_CANCEL: 'ระบบยกเลิกอัตโนมัติ (เลยเวลาแก้ไข 168 ชม.)',
};
const PAY_STATUS_TH = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };

// ───────────────────────── ตัวช่วยทั่วไป ─────────────────────────
const nowIso = () => clock.nowIso();
const notFoundApi = (res) => auth.apiError(res, 404, 'NOT_FOUND', MSG.NOT_FOUND);
const err = (status, code, message, extra) => ({ ok: false, status, code, message: message || MSG[code] || code, extra });
const sendErr = (res, e) => auth.apiError(res, e.status, e.code, e.message, e.extra);

function serviceRow(id) {
  if (!SERVICES.includes(id)) return null;
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id) || { id, name: format.SERVICE_TH[id], sla: rules.DEFAULTS[id].sla };
}
function serviceName(id) {
  const r = SERVICES.includes(id) ? db.prepare('SELECT name FROM services WHERE id = ?').get(id) : null;
  return (r && r.name) || format.SERVICE_TH[id] || id;
}

/** เอกสารของบริการตามลำดับ (CONTRACT 4.3) → [{key,label,required,pdfOnly}] */
function serviceDocs(serviceId) {
  let rows = [];
  try {
    rows = db.prepare('SELECT doc_key, label, required, pdf_only FROM service_docs WHERE service_id = ? ORDER BY sort, rowid').all(serviceId)
      .map((r) => ({ key: r.doc_key, label: r.label, required: !!r.required, pdfOnly: !!r.pdf_only }));
  } catch { rows = []; }
  if (!rows.length) rows = (DOCS_FALLBACK[serviceId] || []).map(([key, label, req, pdf]) => ({ key, label, required: !!req, pdfOnly: !!pdf }));
  return rows;
}

/** magic bytes เท่านั้น (ไม่ดูนามสกุล/Content-Type · BR-06 A-49) */
function sniff(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return { mime: 'application/pdf', ext: 'pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  return null;
}

/** BR-07: ≤ 5,242,880 · B02 ใช้ `<` แทน `≤` */
function sizeOk(n) {
  return bug.isBug('B02') ? n < MAX_FILE_BYTES : n <= MAX_FILE_BYTES;
}

/** id แบบตัวอักษรล้วน (ไม่มีตัวเลขติดกันยาวที่ชนการตรวจ PDPA) */
function randId(n = 20) {
  const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = 'f';
  for (const x of crypto.randomBytes(n)) s += A[x % 52];
  return s;
}

function cleanName(f) {
  let n = (f && f.originalname) || 'file';
  try {
    const u = Buffer.from(n, 'latin1').toString('utf8');
    if (!u.includes('\uFFFD')) n = u;
  } catch { /* ใช้ชื่อเดิม */ }
  n = n.replace(/[\\/\r\n\t"<>]/g, '_').trim() || 'file';
  return n.length > 200 ? n.slice(-200) : n;
}

/** ตรวจไฟล์หนึ่งไฟล์ตามลำดับ: ขนาด → ชนิด → แบบแปลน PDF · คืน {ok, type} หรือ error */
function checkFile(file, doc) {
  const size = file.size != null ? file.size : (file.buffer ? file.buffer.length : 0);
  if (!sizeOk(size)) return err(400, 'FILE_TOO_LARGE');
  const type = sniff(file.buffer);
  if (!type) return err(400, 'FILE_TYPE');
  if (doc && doc.pdfOnly && type.mime !== 'application/pdf') return err(400, 'PLAN_NOT_PDF');
  return { ok: true, type, size };
}

function writeStored(id, type, buf) {
  const storage = `${id}.${type.ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, storage), buf);
  return storage;
}
function unlinkStored(storage) {
  if (!storage) return;
  try { fs.rmSync(path.join(UPLOAD_DIR, path.basename(storage)), { force: true }); } catch { /* ไม่เป็นไร */ }
}

// multer: เก็บในหน่วยความจำ · จำกัดที่ 8 MB (≥ 6 MB ตาม CONTRACT 0.10) แล้วตรวจ 5 MB เอง
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10, fields: 20 } }).any();
function runUpload(req, res) {
  return new Promise((resolve) => {
    if (!req.is('multipart/form-data')) return resolve(null);
    upload(req, res, (e) => {
      if (!e) return resolve(null);
      if (e.code === 'LIMIT_FILE_SIZE') return resolve(err(400, 'FILE_TOO_LARGE'));
      if (e.code === 'LIMIT_FILE_COUNT') return resolve(err(400, 'FILE_COUNT'));
      return resolve(err(400, 'BAD_UPLOAD', 'อัปโหลดไฟล์ไม่สำเร็จ'));
    });
  });
}
function pickedFiles(req) {
  return (req.files || []).filter((f) => f && f.buffer && !(f.size === 0 && !f.originalname));
}

// ───────────────────────── ร่าง ─────────────────────────
function getDraft(id) {
  return typeof id === 'string' ? db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) : null;
}
/** ร่างของผู้ใช้นี้ (ไม่ใช่ของคนอื่น/ไม่ถูกลบ) หรือ null */
function ownDraft(user, id) {
  const d = getDraft(id);
  if (!d || d.status === 'DELETED' || d.user_id !== user.id) return null;
  return d;
}

function draftFiles(draftId) {
  return db.prepare('SELECT id, name, doc_key, size FROM files WHERE draft_id = ? ORDER BY created_at, rowid').all(draftId)
    .map((f) => ({ fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size }));
}

function missingDocs(serviceId, files) {
  const have = new Set(files.map((f) => f.docKey || f.doc_key));
  return serviceDocs(serviceId).filter((d) => d.required && !have.has(d.key)).map((d) => d.label);
}

/** ยอดที่แสดง: DRAFT = คิดจากค่าปัจจุบัน · เข้า PENDING_PAYMENT แล้ว = ยอดที่ล็อก (A-42) */
function draftFee(d) {
  if (d.status === 'DRAFT') {
    const r = rules.calcFee(d.service_id, { qty: d.qty, areaSqm: d.area_sqm }, db);
    if (r.ok) return r.fee;
  }
  return d.fee_locked != null ? d.fee_locked : d.fee;
}

/** QR ล่าสุดของร่าง (PAID มาก่อน) → {ref, amount, status PENDING|PAID|EXPIRED, ...} หรือ null */
function draftPayment(draftId) {
  let p;
  try {
    p = db.prepare(`SELECT * FROM payments WHERE draft_id = ? AND status <> 'VOID'
      ORDER BY (status = 'PAID') DESC, qr_created_at DESC, length(ref) DESC, ref DESC LIMIT 1`).get(draftId);
  } catch { p = null; }
  if (!p) return null;
  let status = 'PENDING';
  if (p.status === 'PAID') status = 'PAID';
  else if (clock.cmp(clock.now(), p.qr_expires_at) >= 0) status = 'EXPIRED';
  return {
    ref: p.ref, amount: p.amount, status, qrCreatedAt: p.qr_created_at, qrExpiresAt: p.qr_expires_at,
    paidAt: p.paid_at || null, caseNo: p.case_no || null, receiptNo: p.receipt_no || null,
  };
}

function draftCaseNo(d) {
  if (d.case_no) return d.case_no;
  const c = db.prepare('SELECT case_no FROM cases WHERE draft_id = ?').get(d.id);
  return c ? c.case_no : null;
}

function draftJson(d) {
  const files = draftFiles(d.id);
  return {
    draftId: d.id, serviceId: d.service_id, serviceName: serviceName(d.service_id), status: d.status,
    qty: d.service_id === 'SV-01' ? d.qty : null, areaSqm: d.service_id === 'SV-03' ? d.area_sqm : null,
    fee: draftFee(d), caseNo: draftCaseNo(d), files, missing: missingDocs(d.service_id, files), payment: draftPayment(d.id),
  };
}

function isPaidDraft(d) {
  if (d.status === 'SUBMITTED' || d.case_no) return true;
  try {
    return !!db.prepare("SELECT 1 FROM payments WHERE draft_id = ? AND status = 'PAID' LIMIT 1").get(d.id);
  } catch { return false; }
}

const createDraftTx = db.transaction((user, serviceId, calc) => {
  const seq = require('../db').nextSeq('draft');
  const id = `DR-${String(seq).padStart(4, '0')}`;
  const now = nowIso();
  db.prepare(`INSERT INTO drafts (id, user_id, service_id, status, qty, area_sqm, fee, fee_locked, locked_at, case_no, created_at, updated_at)
    VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
    .run(id, user.id, serviceId, serviceId === 'SV-01' ? calc.qty : null, serviceId === 'SV-03' ? calc.areaSqm : null, calc.fee, now, now);
  return getDraft(id);
});

function feeInput(body) {
  body = body || {};
  return { qty: body.qty, areaSqm: body.areaSqm !== undefined ? body.areaSqm : body.area_sqm };
}

function createDraft(user, body) {
  const serviceId = body && body.serviceId;
  const svc = serviceRow(serviceId);
  if (!svc) return err(400, 'INVALID_SERVICE');
  const calc = rules.calcFee(svc, feeInput(body), db);
  if (!calc.ok) return err(calc.status || 400, calc.code, calc.message);
  return { ok: true, draft: createDraftTx(user, serviceId, calc) };
}

function updateDraft(user, id, body) {
  const d = ownDraft(user, id);
  if (!d) return err(404, 'NOT_FOUND');
  if (d.status !== 'DRAFT') return err(409, 'INVALID_STATE');
  const calc = rules.calcFee(serviceRow(d.service_id), feeInput(body), db);
  if (!calc.ok) return err(calc.status || 400, calc.code, calc.message);
  db.prepare('UPDATE drafts SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ?')
    .run(d.service_id === 'SV-01' ? calc.qty : null, d.service_id === 'SV-03' ? calc.areaSqm : null, calc.fee, nowIso(), d.id);
  return { ok: true, draft: getDraft(d.id) };
}

const deleteDraftTx = db.transaction((d) => {
  const files = db.prepare('SELECT storage_name FROM files WHERE draft_id = ?').all(d.id);
  db.prepare('DELETE FROM files WHERE draft_id = ?').run(d.id);
  try { db.prepare('DELETE FROM payments WHERE draft_id = ?').run(d.id); } catch { /* ไม่มีตาราง */ }
  db.prepare('DELETE FROM drafts WHERE id = ?').run(d.id);
  return files;
});

/** แนบไฟล์เข้าร่าง (BR-06 BR-07 BR-08) */
function addDraftFile(user, id, docKey, file) {
  const d = ownDraft(user, id);
  if (!d) return err(404, 'NOT_FOUND');
  if (!['DRAFT', 'PENDING_PAYMENT'].includes(d.status) || isPaidDraft(d)) return err(409, 'INVALID_STATE');
  const docs = [...serviceDocs(d.service_id), EXTRA_DOC];
  const doc = docs.find((x) => x.key === docKey);
  if (!doc) return err(400, 'INVALID_DOC_KEY');
  if (!file) return err(400, 'FILE_REQUIRED');
  const chk = checkFile(file, doc);
  if (!chk.ok) return chk;
  const n = db.prepare('SELECT COUNT(*) AS n FROM files WHERE draft_id = ?').get(d.id).n;
  if (n >= MAX_FILES) return err(400, 'FILE_COUNT');
  const fileId = randId();
  const name = cleanName(file);
  const storage = writeStored(fileId, chk.type, file.buffer);
  try {
    db.prepare(`INSERT INTO files (id, draft_id, case_no, doc_key, name, mime, size, storage_name, uploaded_by, is_seed, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?)`).run(fileId, d.id, doc.key, name, chk.type.mime, chk.size, storage, user.id, nowIso());
    db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(nowIso(), d.id);
  } catch (e) {
    unlinkStored(storage);
    throw e;
  }
  return { ok: true, file: { fileId, name, docKey: doc.key, size: chk.size } };
}

// ───────────────────────── คำขอ ─────────────────────────
function getCase(caseNo) {
  return typeof caseNo === 'string' ? db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo) : null;
}
/** ประชาชนเห็นได้เฉพาะของตัวเอง (BR-22) · B06: ข้ามการตรวจเจ้าของ (IDOR) เฉพาะการเปิดดู */
function viewableByCitizen(user, c) {
  if (!c) return false;
  if (c.user_id === user.id) return true;
  return bug.isBug('B06');
}

function safeSla(c) {
  try { return rules.slaInfo(c); } catch { return { level: null, label: '' }; }
}

function fixDeadlineOf(c) {
  if (c.fix_deadline) return clock.toIso(c.fix_deadline);
  const at = c.need_fix_at || latestReturn(c.case_no)?.returned_at;
  return at ? clock.toIso(clock.addMs(at, FIX_WINDOW_MS)) : null;
}

function latestReturn(caseNo) {
  try {
    return db.prepare('SELECT * FROM case_returns WHERE case_no = ? ORDER BY n DESC, id DESC LIMIT 1').get(caseNo) || null;
  } catch { return null; }
}

function returnReason(c) {
  const r = latestReturn(c.case_no);
  if (r && r.reason) return r.reason;
  const e = db.prepare("SELECT note FROM case_events WHERE case_no = ? AND event = 'RETURN' ORDER BY time DESC, id DESC LIMIT 1").get(c.case_no);
  return e ? e.note || '' : '';
}

function caseDocument(caseNo) {
  try { return db.prepare('SELECT doc_no, verify_code FROM documents WHERE case_no = ?').get(caseNo) || null; } catch { return null; }
}

/** ไฟล์ของคำขอ (ไฟล์ที่ผูก case_no + ไฟล์ของร่างที่ชำระเป็นคำขอนี้) */
function caseFiles(c) {
  const draftIds = new Set();
  if (c.draft_id) draftIds.add(c.draft_id);
  for (const r of db.prepare('SELECT id FROM drafts WHERE case_no = ?').all(c.case_no)) draftIds.add(r.id);
  const ids = [...draftIds];
  const q = `SELECT id, name, doc_key, size FROM files WHERE case_no = ?${ids.length ? ` OR draft_id IN (${ids.map(() => '?').join(',')})` : ''}
    ORDER BY created_at, rowid`;
  return db.prepare(q).all(c.case_no, ...ids).map((f) => ({ fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size }));
}

function applicantOf(c) {
  return db.prepare('SELECT id, name, id_no_enc, id_masked FROM users WHERE id = ?').get(c.user_id) || { name: '' };
}

function fullIdNo(u) {
  try { return u && u.id_no_enc ? pii.decrypt(u.id_no_enc) : null; } catch { return null; }
}

/** JSON ตาม CONTRACT 6.7 · ประชาชนได้ idNo เต็ม · เจ้าหน้าที่ได้ idMasked เท่านั้น */
function caseJson(c, viewerIsCitizen) {
  const u = applicantOf(c);
  const doc = caseDocument(c.case_no);
  const out = {
    caseNo: c.case_no, serviceId: c.service_id, status: c.status,
    step: c.service_id === 'SV-03' && c.step != null ? c.step : null,
    fee: c.fee, paidAt: c.paid_at || null, dueAt: c.due_at ? clock.toIso(c.due_at) : null, slaLevel: safeSla(c).level,
    owner: c.owner || null, returnCount: c.return_count || 0, closedAt: c.closed_at || null,
    applicantName: u.name || '',
  };
  if (viewerIsCitizen) out.idNo = fullIdNo(u);
  else out.idMasked = u.id_masked || pii.maskIdNo(fullIdNo(u));
  out.fixDeadline = c.status === 'NEED_FIX' ? fixDeadlineOf(c) : null;
  out.docNo = doc ? doc.doc_no : null;
  out.verifyCode = doc ? doc.verify_code : null;
  return out;
}

function addEvent(caseNo, time, actor, event, from, to, note) {
  db.prepare('INSERT INTO case_events (case_no, time, actor, event, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(caseNo, time, actor, event, from, to, note == null ? null : String(note));
}

/** ยกเลิกอัตโนมัติเมื่อเลย 168 ชม. (idempotent) · คืน true ถ้าเพิ่งยกเลิก */
const expireFixTx = db.transaction((caseNo, deadline) => {
  const r = db.prepare(`UPDATE cases SET status = 'CANCELLED', dept = NULL, cancelled_at = ?, cancel_reason = 'auto-fix-expired', updated_at = ?
    WHERE case_no = ? AND status = 'NEED_FIX'`).run(deadline, deadline, caseNo);
  if (r.changes !== 1) return false;
  addEvent(caseNo, deadline, 'system', 'AUTO_CANCEL', 'NEED_FIX', 'CANCELLED', 'หมดเวลาแก้ไข 168 ชม. ระบบยกเลิกคำขออัตโนมัติ');
  return true;
});

function expireIfDue(c, now = clock.now()) {
  if (!c || c.status !== 'NEED_FIX') return false;
  const deadline = fixDeadlineOf(c);
  if (!deadline || clock.cmp(now, deadline) < 0) return false;
  return expireFixTx(c.case_no, deadline);
}

function sweepExpiredFixes() {
  const rows = db.prepare("SELECT * FROM cases WHERE status = 'NEED_FIX'").all();
  if (!rows.length) return;
  const now = clock.now();
  for (const c of rows) expireIfDue(c, now);
}

/** ยกเลิกโดยประชาชน: เฉพาะ SUBMITTED ที่ยังไม่มีผู้รับ (BR-22) · UPDATE แบบมีเงื่อนไข = ชนกับรับเรื่องสำเร็จฝั่งเดียว */
const cancelTx = db.transaction((caseNo) => {
  const now = nowIso();
  const r = db.prepare(`UPDATE cases SET status = 'CANCELLED', dept = NULL, cancelled_at = ?, cancel_reason = 'citizen', updated_at = ?
    WHERE case_no = ? AND status = 'SUBMITTED' AND (owner IS NULL OR owner = '')`).run(now, now, caseNo);
  if (r.changes !== 1) return false;
  addEvent(caseNo, now, 'citizen', 'CANCEL', 'SUBMITTED', 'CANCELLED', 'ประชาชนยกเลิกคำขอเอง');
  return true;
});

function cancelCase(user, caseNo) {
  const c = getCase(caseNo);
  if (!c || c.user_id !== user.id) return err(404, 'NOT_FOUND');
  if (cancelTx(c.case_no)) return { ok: true, status: 'CANCELLED' };
  const cur = getCase(c.case_no);
  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(cur.status)) return err(409, 'INVALID_STATE');
  return err(409, 'CANNOT_CANCEL');
}

/** ส่งแก้ไข (NEED_FIX → IN_REVIEW กับผู้ถือเดิม · ขยายกำหนดตาม BR-13 · ไฟล์ใหม่ไม่บังคับ) */
function resubmitCase(user, caseNo, files) {
  let c = getCase(caseNo);
  if (!c || c.user_id !== user.id) return err(404, 'NOT_FOUND');
  if (c.status === 'NEED_FIX' && expireIfDue(c)) c = getCase(caseNo);
  if (c.status === 'CANCELLED' && c.cancel_reason !== 'citizen' && (c.need_fix_at || c.return_count > 0)) return err(409, 'FIX_WINDOW_EXPIRED');
  if (c.status !== 'NEED_FIX') return err(409, 'INVALID_STATE');

  // ตรวจไฟล์ใหม่ทั้งหมดก่อนเปลี่ยนสถานะ
  const checked = [];
  const existing = caseFiles(c).length;
  for (const f of files || []) {
    const chk = checkFile(f, EXTRA_DOC);
    if (!chk.ok) return chk;
    checked.push({ f, chk });
  }
  if (existing + checked.length > MAX_FILES) return err(400, 'FILE_COUNT');

  const now = nowIso();
  const lr = latestReturn(c.case_no);
  const returnedAt = c.need_fix_at || (lr && lr.returned_at) || now;
  const ext = c.due_at ? rules.needFixExtension(c.due_at, returnedAt, now) : { dueAt: null, pausedDays: 0 };

  const stored = [];
  try {
    for (const { f, chk } of checked) {
      const fileId = randId();
      stored.push({ fileId, name: cleanName(f), mime: chk.type.mime, size: chk.size, storage: writeStored(fileId, chk.type, f.buffer) });
    }
    const ok = db.transaction(() => {
      const r = db.prepare(`UPDATE cases SET status = 'IN_REVIEW', due_at = ?, fix_deadline = NULL, updated_at = ?
        WHERE case_no = ? AND status = 'NEED_FIX'`).run(ext.dueAt, now, c.case_no);
      if (r.changes !== 1) return false;
      try {
        db.prepare(`UPDATE case_returns SET resubmitted_at = ?, paused_days = ?
          WHERE case_no = ? AND n = (SELECT MAX(n) FROM case_returns WHERE case_no = ?) AND resubmitted_at IS NULL`)
          .run(now, ext.pausedDays, c.case_no, c.case_no);
      } catch { /* ไม่มีประวัติตีกลับ */ }
      for (const s of stored) {
        db.prepare(`INSERT INTO files (id, draft_id, case_no, doc_key, name, mime, size, storage_name, uploaded_by, is_seed, created_at)
          VALUES (?, NULL, ?, 'extra', ?, ?, ?, ?, ?, 0, ?)`).run(s.fileId, c.case_no, s.name, s.mime, s.size, s.storage, user.id, now);
      }
      addEvent(c.case_no, now, 'citizen', 'RESUBMIT', 'NEED_FIX', 'IN_REVIEW',
        stored.length ? `ส่งเอกสารแก้ไขแล้ว (แนบไฟล์ใหม่ ${stored.length} ไฟล์)` : 'ส่งเอกสารแก้ไขแล้ว');
      return true;
    })();
    if (!ok) {
      stored.forEach((s) => unlinkStored(s.storage));
      return err(409, 'INVALID_STATE');
    }
  } catch (e) {
    stored.forEach((s) => unlinkStored(s.storage));
    throw e;
  }
  return { ok: true, status: 'IN_REVIEW', dueAt: ext.dueAt };
}

// ───────────────────────── ส่วนแสดงผล ─────────────────────────
const PAGE_STYLE = `
.wiz section{margin:1rem 0}
.wiz .actions,.case-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}
.wiz .fee{font-size:1.25rem}
.file-list{list-style:none;padding:0;margin:.5rem 0}
.file-list li{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between;padding:.4rem .5rem;border:1px solid #d0d4da;border-radius:6px;margin:.25rem 0;background:#fff}
.missing{color:#a40e0e;font-weight:600}
.badge{display:inline-block;padding:.1rem .5rem;border:1px solid #3d4451;border-radius:1rem;background:#fff;color:#1a1a1a;font-weight:600}
.badge::before{content:"● "}
.kv{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.25rem 1rem;margin:0}
.kv dt{font-weight:600}.kv dd{margin:0}
.panel{background:#fff;border:1px solid #d0d5dd;border-radius:8px;padding:1rem;margin:1rem 0}
.qr svg{width:160px;height:160px;border:1px solid #1a1a1a;background:#fff}
.timeline{padding-left:1.25rem}
.timeline li{margin:.35rem 0}
.svc-list{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0}
a.btn{display:inline-block;text-decoration:none}
a.btn.secondary{background:#fff;color:#0b4f9c}
.muted{color:#3d4451}
`;

function statusBadge(testid, status) {
  return html`<span class="badge" data-testid="${testid}" data-status="${status}">${format.STATUS_TH[status] || status}</span>`;
}
function timeEl(testid, iso, text) {
  if (!iso) return html`<span data-testid="${testid}">–</span>`;
  const v = clock.toIso(iso);
  return html`<time data-testid="${testid}" data-iso="${v}" datetime="${v}">${text != null ? text : clock.formatThai(v)}</time>`;
}
function page(req, res, opts) {
  return auth.sendPage(req, res, { ...opts, body: html`<style>${raw(PAGE_STYLE)}</style>${opts.body}` });
}

// ── /citizen ──
function citizenHome(req, res) {
  const u = req.user;
  const cases = db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY case_no DESC').all(u.id);
  const drafts = db.prepare(`SELECT * FROM drafts WHERE user_id = ? AND status IN ('DRAFT','PENDING_PAYMENT') AND case_no IS NULL
    ORDER BY created_at DESC, id DESC`).all(u.id).filter((d) => !isPaidDraft(d));

  const svcButtons = SERVICES.map((id) => html`<li><a class="btn" data-testid="start-service-${id}" href="/citizen/new/${id}">${id} ${serviceName(id)}</a></li>`);
  const caseRows = cases.map((c) => html`<tr data-testid="my-case-row" data-case-no="${c.case_no}" data-status="${c.status}">
<td data-testid="row-case-no"><a href="/citizen/cases/${c.case_no}">${c.case_no}</a></td>
<td data-testid="row-service">${c.service_id} ${serviceName(c.service_id)}</td>
<td data-testid="row-status" data-status="${c.status}">${format.STATUS_TH[c.status] || c.status}</td>
<td>${timeEl('row-due', c.due_at)}</td></tr>`);
  const draftRows = drafts.map((d) => html`<tr data-testid="my-draft-row" data-draft-id="${d.id}" data-status="${d.status}">
<td data-testid="row-draft-id">${d.id}</td>
<td data-testid="row-service">${d.service_id} ${serviceName(d.service_id)}</td>
<td data-testid="row-status" data-status="${d.status}">${format.STATUS_TH[d.status] || d.status}</td>
<td>${format.baht(draftFee(d))}</td>
<td><a class="btn secondary" data-testid="open-draft-btn" href="/citizen/new/${d.service_id}?draft=${d.id}" aria-label="เปิดร่าง ${d.id}">เปิดร่าง</a></td></tr>`);

  const body = html`<h1 data-testid="citizen-welcome">สวัสดี ${u.name}</h1>
<section aria-labelledby="h-start"><h2 id="h-start">เริ่มยื่นคำขอ</h2><ul class="svc-list">${svcButtons}</ul></section>
<section aria-labelledby="h-drafts"><h2 id="h-drafts">ร่างและรอชำระเงิน</h2>
${drafts.length ? html`<div class="table-wrap"><table><caption class="visually-hidden">ร่างและรอชำระเงิน</caption>
<thead><tr><th scope="col">รหัสร่าง</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>${draftRows}</tbody></table></div>` : html`<p class="muted">ไม่มีร่าง</p>`}</section>
<section aria-labelledby="h-cases"><h2 id="h-cases">คำขอของฉัน</h2>
${cases.length ? html`<div class="table-wrap"><table><caption class="visually-hidden">คำขอของฉัน</caption>
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th></tr></thead>
<tbody>${caseRows}</tbody></table></div>` : html`<p class="muted">ยังไม่มีคำขอ</p>`}</section>`;
  return page(req, res, { title: 'คำขอของฉัน', body });
}

// ── /citizen/new/:service ──
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function wizardPage(req, res) {
  const serviceId = req.params.service;
  const svc = serviceRow(serviceId);
  if (!svc) return auth.notFoundPage(req, res);
  let draft = null;
  if (req.query.draft !== undefined) {
    const d = ownDraft(req.user, String(req.query.draft));
    if (!d) return auth.notFoundPage(req, res);
    if (d.service_id !== serviceId) return res.redirect(302, `/citizen/new/${d.service_id}?draft=${encodeURIComponent(d.id)}`);
    draft = draftJson(d);
  }
  let step = 1;
  if (draft) {
    const want = Number(req.query.step);
    if (draft.status !== 'DRAFT' || draft.caseNo) step = 3;
    else if (want === 2) step = 2;
    else if (want === 3) step = draft.missing.length ? 2 : 3;
  }
  const docs = serviceDocs(serviceId);
  const initQty = draft && draft.qty != null ? String(draft.qty) : String(rules.QTY_DEFAULT);
  const initArea = draft && draft.areaSqm != null ? String(draft.areaSqm) : '';
  let initFee = null;
  const q = rules.calcFee(svc, serviceId === 'SV-01' ? { qty: initQty } : serviceId === 'SV-03' ? { areaSqm: initArea } : {}, db);
  if (q.ok) initFee = q.fee;
  if (draft && draft.status === 'DRAFT' && q.ok) draft.fee = q.fee;

  const state = { serviceId, step, draft, docs: [...docs, EXTRA_DOC], fee: initFee };
  const stepText = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' };

  const inputs = [];
  if (serviceId === 'SV-01') {
    inputs.push(html`<div class="field"><label for="qty-input">จำนวนฉบับ (1–5 ฉบับ · ฉบับละ ${format.baht(svc.fee != null ? svc.fee : 20)})</label>
<input id="qty-input" name="qty" data-testid="qty-input" type="number" inputmode="numeric" step="1" value="${initQty}" autocomplete="off"></div>`);
  }
  if (serviceId === 'SV-03') {
    inputs.push(html`<div class="field"><label for="area-input">พื้นที่ก่อสร้าง/ต่อเติม (ตร.ม. จำนวนเต็ม 1–500)</label>
<input id="area-input" name="areaSqm" data-testid="area-input" type="number" inputmode="numeric" step="1" value="${initArea}" autocomplete="off"></div>`);
  }
  if (serviceId === 'SV-02') inputs.push(html`<p class="muted">ค่าธรรมเนียมคงที่ ไม่ต้องกรอกข้อมูลเพิ่มเติม</p>`);

  const uploadFields = state.docs.map((d) => html`<div class="field"><label for="up-${d.key}">${d.label}${d.required ? ' ✱ (จำเป็น)' : ' (ไม่บังคับ)'}${d.pdfOnly ? ' · PDF เท่านั้น' : ''}${d.key === 'extra' ? ' · เลือกได้หลายไฟล์' : ''}</label>
<input id="up-${d.key}" type="file" data-testid="upload-input-${d.key}" data-doc-key="${d.key}"${raw(d.key === 'extra' ? ' multiple' : '')}></div>`);

  const body = html`<div class="wiz">
<h1>ยื่นคำขอ: <span data-testid="service-name">${svc.name || serviceName(serviceId)}</span></h1>
<p>ขั้นตอน <strong data-testid="wizard-step" id="wiz-step">${stepText[step]}</strong></p>
<p id="draft-id-wrap"${raw(draft ? '' : ' hidden')}>รหัสร่าง: <strong data-testid="draft-id" id="draft-id">${draft ? draft.draftId : ''}</strong></p>
<div data-testid="action-error" id="wiz-error" role="alert" class="error" hidden></div>
<div data-testid="action-success" id="wiz-success" role="status" class="success" hidden></div>

<section id="step-1" aria-labelledby="h-step-1"${raw(step === 1 ? '' : ' hidden')}>
<h2 id="h-step-1" tabindex="-1">1. กรอกข้อมูล</h2>
${inputs}
<p class="fee">ค่าธรรมเนียม: <strong data-testid="fee-total" id="fee-total" aria-live="polite">${initFee == null ? '–' : format.baht(initFee)}</strong></p>
<p data-testid="fee-error" id="fee-error" role="alert" class="error" hidden></p>
<div class="actions">
<button type="button" class="secondary" data-testid="save-draft-btn" id="save-draft-btn"${raw(initFee == null ? ' disabled' : '')}>บันทึกร่าง</button>
<button type="button" data-testid="to-upload-btn" id="to-upload-btn"${raw(initFee == null ? ' disabled' : '')}>ถัดไป: แนบเอกสาร</button>
</div></section>

<section id="step-2" aria-labelledby="h-step-2"${raw(step === 2 ? '' : ' hidden')}>
<h2 id="h-step-2" tabindex="-1">2. แนบเอกสาร</h2>
<p class="muted">รองรับไฟล์ PDF, JPG, PNG ขนาดไม่เกิน 5 MB ต่อไฟล์ และรวมไม่เกิน 5 ไฟล์ต่อคำขอ (✱ = เอกสารบังคับ)</p>
${uploadFields}
<p data-testid="upload-error" id="upload-error" role="alert" class="error" hidden></p>
<h3>ไฟล์ที่แนบแล้ว</h3>
<ul class="file-list" id="file-list" aria-live="polite"></ul>
<div id="missing-wrap"></div>
<div class="actions">
<button type="button" class="secondary" id="back-to-1">ย้อนกลับ</button>
<button type="button" data-testid="to-payment-btn" id="to-payment-btn" disabled>ไปชำระเงิน</button>
</div></section>

<section id="step-3" aria-labelledby="h-step-3"${raw(step === 3 ? '' : ' hidden')}>
<h2 id="h-step-3" tabindex="-1">3. ชำระเงิน (PromptPay QR จำลอง)</h2>
<p class="fee">ยอดที่ต้องชำระ: <strong data-testid="payment-amount" id="payment-amount">${draft ? format.baht(draft.fee) : (initFee == null ? '–' : format.baht(initFee))}</strong></p>
<div id="pay-box" class="panel" aria-live="polite"></div>
<div class="actions"><button type="button" class="secondary" id="back-to-2">ย้อนกลับ</button></div>
</section>
</div>
<script type="application/json" id="wiz-data">${raw(jsonForScript(state))}</script>
<script>${raw(WIZARD_JS)}</script>`;
  return page(req, res, { title: `ยื่นคำขอ ${serviceId}`, body });
}

// ── /citizen/cases/:caseNo ──
function caseView(req, res, opts = {}) {
  const c = getCase(req.params.caseNo);
  if (!viewableByCitizen(req.user, c)) return auth.notFoundPage(req, res);
  const sla = safeSla(c);
  const u = applicantOf(c);
  const idFull = fullIdNo(u);
  const files = caseFiles(c);
  const doc = caseDocument(c.case_no);
  const events = db.prepare('SELECT * FROM case_events WHERE case_no = ? ORDER BY time, id').all(c.case_no);
  const own = c.user_id === req.user.id;
  const canCancel = own && c.status === 'SUBMITTED' && !c.owner;
  const fixDeadline = c.status === 'NEED_FIX' ? fixDeadlineOf(c) : null;
  const canFix = own && c.status === 'NEED_FIX' && fixDeadline && clock.cmp(clock.now(), fixDeadline) < 0;
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

  const timeline = events.map((e) => html`<li data-testid="timeline-item" data-iso="${clock.toIso(e.time)}">
<time datetime="${clock.toIso(e.time)}">${clock.formatThai(e.time)}</time> · ${EVENT_TH[e.event] || e.event}${e.to_status ? html` → ${format.STATUS_TH[e.to_status] || e.to_status}` : ''}${['RETURN', 'REJECT'].includes(e.event) && e.note ? html` (เหตุผล: ${e.note})` : ''}</li>`);

  const docItems = files.map((f) => html`<li data-testid="doc-item" data-name="${f.name}" data-file-id="${f.fileId}">
<a data-testid="doc-download-link" href="/api/files/${f.fileId}">${f.name}</a> <span class="muted">(${docLabel(c.service_id, f.docKey)} · ${fmtSize(f.size)})</span></li>`);

  const body = html`<h1>คำขอ <span data-testid="case-no">${c.case_no}</span></h1>
<div class="panel"><dl class="kv">
<dt>สถานะ</dt><dd>${statusBadge('case-status', c.status)}</dd>
<dt>บริการ</dt><dd data-testid="case-service">${c.service_id} ${serviceName(c.service_id)}</dd>
${c.service_id === 'SV-03' && c.step && STEP_TH[c.step] ? html`<dt>ขั้นตอน</dt><dd data-testid="case-step">${STEP_TH[c.step]}</dd>` : ''}
<dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${format.baht(c.fee)}</dd>
<dt>กำหนดเสร็จ</dt><dd>${timeEl('sla-due', c.due_at)}</dd>
<dt>ระดับเตือน</dt><dd>${sla.level ? html`<span class="badge" data-testid="sla-level" data-level="${sla.level}">${format.LEVEL_TH[sla.level]}</span>` : html`<span data-testid="sla-level" data-level="">–</span>`}</dd>
${['COMPLETED', 'REJECTED'].includes(c.status) && c.closed_at ? html`<dt>ปิดงานเมื่อ</dt><dd>${timeEl('closed-at', c.closed_at)}</dd>` : ''}
<dt>ผู้ยื่น</dt><dd>${u.name}</dd>
${own ? html`<dt>เลขบัตรประชาชน</dt><dd data-testid="case-id-full">${pii.formatIdNo(idFull)}</dd>` : ''}
</dl></div>
${['REJECTED', 'CANCELLED'].includes(c.status) ? html`<p class="panel" data-testid="no-refund-note">${MSG.NO_REFUND}</p>` : ''}
${c.status === 'NEED_FIX' ? html`<section class="panel" aria-labelledby="h-fix"><h2 id="h-fix">ต้องแก้ไขเอกสาร</h2>
<p>เหตุผลที่ถูกตีกลับ: <strong data-testid="return-reason-display">${returnReason(c)}</strong></p>
<p>ส่งแก้ไขได้ถึง: ${timeEl('fix-deadline', fixDeadline)}</p>
${canFix ? html`<form method="post" action="/citizen/cases/${c.case_no}/resubmit" enctype="multipart/form-data">
<div class="field"><label for="fix-upload-input">แนบไฟล์ใหม่ (ไม่บังคับ · PDF, JPG, PNG ไม่เกิน 5 MB)</label>
<input id="fix-upload-input" name="file" type="file" data-testid="fix-upload-input" multiple></div>
<button type="submit" data-testid="submit-fix-btn">ส่งแก้ไข</button></form>` : html`<p class="muted">พ้นเส้นตายแก้ไขแล้ว</p>`}
</section>` : ''}
${doc ? html`<section class="panel" aria-labelledby="h-doc"><h2 id="h-doc">เอกสารดิจิทัล</h2>
<dl class="kv"><dt>เลขเอกสาร</dt><dd data-testid="doc-no">${doc.doc_no}</dd>
<dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${doc.verify_code}</dd></dl>
<div class="qr" data-testid="doc-qr" data-url="${base}/verify/${doc.verify_code}" role="img" aria-label="QR สำหรับตรวจเอกสารที่ ${base}/verify/${doc.verify_code}">${raw(qrSvg(`${base}/verify/${doc.verify_code}`))}</div>
<p><a class="btn" data-testid="download-doc-btn" href="/api/documents/${doc.doc_no}/pdf" download="${doc.doc_no}.pdf">ดาวน์โหลดเอกสาร</a></p></section>` : ''}
<section aria-labelledby="h-files"><h2 id="h-files">เอกสารแนบ</h2>
${files.length ? html`<ul class="file-list">${docItems}</ul>` : html`<p class="muted">ไม่มีไฟล์แนบ</p>`}</section>
<section aria-labelledby="h-tl"><h2 id="h-tl">ไทม์ไลน์</h2><ol class="timeline" data-testid="case-timeline">${timeline}</ol></section>
${canCancel ? html`<div class="case-actions">
<button type="button" class="secondary" data-testid="cancel-case-btn" id="cancel-case-btn" aria-expanded="false" aria-controls="cancel-confirm">ยกเลิกคำขอ</button></div>
<div id="cancel-confirm" class="panel" role="dialog" aria-modal="false" aria-labelledby="cancel-confirm-title" hidden>
<h2 id="cancel-confirm-title">ยืนยันการยกเลิกคำขอ ${c.case_no}</h2>
<p data-testid="cancel-confirm-text">${MSG.NO_REFUND}</p>
<form method="post" action="/citizen/cases/${c.case_no}/cancel" class="case-actions">
<button type="submit" data-testid="confirm-cancel-btn">ยืนยันยกเลิก</button>
<button type="button" class="secondary" id="cancel-dismiss">ไม่ยกเลิก</button></form></div>
<script>${raw(CANCEL_JS)}</script>` : ''}
<p><a href="/citizen">กลับไปคำขอของฉัน</a></p>`;
  return page(req, res, { title: `คำขอ ${c.case_no}`, body, error: opts.error, success: opts.success, status: opts.status });
}

function docLabel(serviceId, key) {
  if (key === 'extra') return EXTRA_DOC.label;
  const d = serviceDocs(serviceId).find((x) => x.key === key);
  return d ? d.label : key;
}
function fmtSize(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} ไบต์`;
}

/** ภาพ QR จำลอง (ลวดลายคงที่จากข้อความ · ไม่ใช่ QR จริง) */
function qrSvg(text) {
  const h = crypto.createHash('sha256').update(String(text)).digest();
  const N = 21;
  let rects = '';
  const finder = (x, y) => (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let on;
      if (finder(x, y)) {
        const fx = x >= N - 7 ? x - (N - 7) : x;
        const fy = y >= N - 7 ? y - (N - 7) : y;
        on = fx === 0 || fx === 6 || fy === 0 || fy === 6 || (fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4);
      } else {
        const i = y * N + x;
        on = (h[i % 32] >> (i % 8)) & 1;
      }
      if (on) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  return `<svg viewBox="-1 -1 ${N + 2} ${N + 2}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><rect x="-1" y="-1" width="${N + 2}" height="${N + 2}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

// ───────────────────────── สคริปต์ฝั่งหน้า ─────────────────────────
const CANCEL_JS = `(function(){
var b=document.getElementById('cancel-case-btn'),box=document.getElementById('cancel-confirm'),no=document.getElementById('cancel-dismiss');
if(!b||!box)return;
b.addEventListener('click',function(){box.hidden=false;b.setAttribute('aria-expanded','true');var t=box.querySelector('[data-testid=confirm-cancel-btn]');if(t)t.focus();});
if(no)no.addEventListener('click',function(){box.hidden=true;b.setAttribute('aria-expanded','false');b.focus();});
})();`;

const WIZARD_JS = `(function(){
'use strict';
var S=JSON.parse(document.getElementById('wiz-data').textContent);
var TH=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
var STEP_TEXT={1:'1/3 กรอกข้อมูล',2:'2/3 แนบเอกสาร',3:'3/3 ชำระเงิน'};
var PAY_TH=${JSON.stringify(PAY_STATUS_TH)};
function $(id){return document.getElementById(id);}
function el(tag,attrs,text){var e=document.createElement(tag);if(attrs)for(var k in attrs){if(attrs[k]!==null&&attrs[k]!==undefined)e.setAttribute(k,attrs[k]);}if(text!==undefined&&text!==null)e.textContent=text;return e;}
function pad(n){return (n<10?'0':'')+n;}
function fmt(iso){var t=Date.parse(iso);if(isNaN(t))return '';var d=new Date(t+7*3600000);return d.getUTCDate()+' '+TH[d.getUTCMonth()]+' '+(d.getUTCFullYear()+543)+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());}
function baht(n){return '\\u0E3F'+Math.round(Number(n)||0).toLocaleString('en-US');}
function api(method,url,body){
  var o={method:method,credentials:'same-origin',headers:{'Accept':'application/json'}};
  if(body instanceof FormData){o.body=body;}else if(body!==undefined){o.headers['Content-Type']='application/json';o.body=JSON.stringify(body);}
  return fetch(url,o).then(function(r){return r.text().then(function(t){var d=null;try{d=t?JSON.parse(t):null;}catch(e){d=null;}return {status:r.status,data:d};});})
    .catch(function(){return {status:0,data:{message:'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'}};});
}
function showMsg(id,text){var e=$(id);if(!e)return;if(text){e.textContent=text;e.hidden=false;}else{e.textContent='';e.hidden=true;}}
function errText(r){return (r&&r.data&&r.data.message)||'เกิดข้อผิดพลาด กรุณาลองใหม่';}

// ---------- ขั้น 1: ค่าธรรมเนียม ----------
var qtyIn=$('qty-input'),areaIn=$('area-input'),feeOk=S.fee!==null&&S.fee!==undefined,quoteSeq=0;
function feeParams(){var p={serviceId:S.serviceId};if(qtyIn)p.qty=qtyIn.value;if(areaIn)p.areaSqm=areaIn.value;return p;}
function renderFee(ok,fee,msg){
  feeOk=ok;$('fee-total').textContent=ok?baht(fee):'\\u2013';showMsg('fee-error',ok?'':msg);
  $('to-upload-btn').disabled=!ok;$('save-draft-btn').disabled=!ok;
}
function quote(){
  var my=++quoteSeq,p=feeParams(),qs=Object.keys(p).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(p[k]);}).join('&');
  return api('GET','/api/fee-quote?'+qs).then(function(r){
    if(my!==quoteSeq)return;
    if(r.status===200&&r.data&&r.data.ok)renderFee(true,r.data.fee);
    else renderFee(false,null,errText(r));
  });
}
[qtyIn,areaIn].forEach(function(i){if(!i)return;i.addEventListener('input',quote);i.addEventListener('change',quote);});

function setDraft(d){
  S.draft=d;
  if(d){$('draft-id').textContent=d.draftId;$('draft-id-wrap').hidden=false;
    try{var u=new URL(location.href);u.searchParams.set('draft',d.draftId);u.searchParams.delete('step');history.replaceState(null,'',u.pathname+u.search);}catch(e){}}
}
function refreshDraft(){
  if(!S.draft)return Promise.resolve(null);
  return api('GET','/api/drafts/'+encodeURIComponent(S.draft.draftId)).then(function(r){if(r.status===200&&r.data){setDraft(r.data);renderFiles();}return r;});
}
function saveDraft(){
  var body=feeParams(),req;
  if(S.draft&&S.draft.status==='DRAFT')req=api('PUT','/api/drafts/'+encodeURIComponent(S.draft.draftId),body);
  else if(S.draft)return Promise.resolve({status:200,data:S.draft});
  else req=api('POST','/api/drafts',body);
  return req.then(function(r){
    if((r.status===200||r.status===201)&&r.data){var id=r.data.draftId||(S.draft&&S.draft.draftId);setDraft({draftId:id,status:'DRAFT',files:[],missing:[],fee:r.data.fee});return refreshDraft().then(function(){return r;});}
    if(r.data&&/INVALID_QTY|INVALID_AREA|AREA_TOO_LARGE/.test(r.data.code||''))renderFee(false,null,r.data.message);
    return r;
  });
}
var busy=false;
$('save-draft-btn').addEventListener('click',function(){
  if(busy)return;busy=true;showMsg('wiz-error','');showMsg('wiz-success','');
  saveDraft().then(function(r){busy=false;if(r.status===200||r.status===201)showMsg('wiz-success','บันทึกร่างแล้ว');else showMsg('wiz-error',errText(r));});
});
$('to-upload-btn').addEventListener('click',function(){
  if(busy||!feeOk)return;busy=true;showMsg('wiz-error','');showMsg('wiz-success','');
  saveDraft().then(function(r){busy=false;if(r.status===200||r.status===201)go(2);else showMsg('wiz-error',errText(r));});
});

// ---------- ขั้น 2: แนบเอกสาร ----------
var uploading=0;
function renderFiles(){
  var list=$('file-list');if(!list)return;
  while(list.firstChild)list.removeChild(list.firstChild);
  var d=S.draft||{files:[],missing:[]};
  (d.files||[]).forEach(function(f){
    var li=el('li',{'data-testid':'file-item','data-name':f.name,'data-doc-key':f.docKey,'data-file-id':f.fileId});
    var lab=(S.docs.filter(function(x){return x.key===f.docKey;})[0]||{label:f.docKey}).label;
    li.appendChild(el('span',null,f.name+' ('+lab+')'));
    var b=el('button',{type:'button','class':'secondary','data-testid':'file-remove-btn','aria-label':'ลบไฟล์ '+f.name},'ลบ');
    b.addEventListener('click',function(){removeFile(f.fileId,b);});
    li.appendChild(b);list.appendChild(li);
  });
  var wrap=$('missing-wrap');while(wrap.firstChild)wrap.removeChild(wrap.firstChild);
  var miss=d.missing||[];
  if(miss.length)wrap.appendChild(el('p',{'data-testid':'missing-docs','class':'missing'},'ยังขาดเอกสาร: '+miss.join(', ')));
  $('to-payment-btn').disabled=!!(miss.length||uploading||!S.draft);
  $('back-to-1').hidden=!(S.draft&&S.draft.status==='DRAFT');
}
function removeFile(id,btn){
  if(!S.draft)return;btn.disabled=true;
  api('DELETE','/api/drafts/'+encodeURIComponent(S.draft.draftId)+'/files/'+encodeURIComponent(id)).then(function(r){
    if(r.status!==204&&r.status!==200)showMsg('upload-error',errText(r));
    return refreshDraft();
  });
}
function uploadOne(docKey,file){
  var fd=new FormData();fd.append('docKey',docKey);fd.append('file',file,file.name);
  return api('POST','/api/drafts/'+encodeURIComponent(S.draft.draftId)+'/files',fd);
}
Array.prototype.forEach.call(document.querySelectorAll('input[type=file][data-doc-key]'),function(inp){
  inp.addEventListener('change',function(){
    var files=Array.prototype.slice.call(inp.files||[]);if(!files.length||!S.draft)return;
    var key=inp.getAttribute('data-doc-key'),lastErr='';uploading++;showMsg('upload-error','');renderFiles();
    var chain=Promise.resolve();
    files.forEach(function(f){chain=chain.then(function(){return uploadOne(key,f).then(function(r){if(r.status!==201)lastErr=errText(r);});});});
    chain.then(function(){uploading--;try{inp.value='';}catch(e){}return refreshDraft();}).then(function(){showMsg('upload-error',lastErr);renderFiles();});
  });
});
$('to-payment-btn').addEventListener('click',function(){
  refreshDraft().then(function(){if(S.draft&&!(S.draft.missing||[]).length)go(3);});
});
$('back-to-1').addEventListener('click',function(){go(1);});

// ---------- ขั้น 3: ชำระเงิน (API ของบล็อกชำระเงิน) ----------
var pay=null,pollTimer=null;
function qrSvg(text){
  var N=21,h=0,s='',i,x,y;for(i=0;i<text.length;i++){h=(h*31+text.charCodeAt(i))>>>0;}
  function rnd(){h^=h<<13;h>>>=0;h^=h>>>17;h^=h<<5;h>>>=0;return h;}
  function finder(x,y){return (x<7&&y<7)||(x>=N-7&&y<7)||(x<7&&y>=N-7);}
  for(y=0;y<N;y++)for(x=0;x<N;x++){var on;if(finder(x,y)){var fx=x>=N-7?x-(N-7):x,fy=y>=N-7?y-(N-7):y;on=fx===0||fx===6||fy===0||fy===6||(fx>=2&&fx<=4&&fy>=2&&fy<=4);}else on=rnd()&1;
    if(on)s+='<rect x="'+x+'" y="'+y+'" width="1" height="1"/>';}
  return '<svg viewBox="-1 -1 23 23" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><rect x="-1" y="-1" width="23" height="23" fill="#fff"/><g fill="#000">'+s+'</g></svg>';
}
function btn(testid,text,fn){var b=el('button',{type:'button','data-testid':testid},text);b.addEventListener('click',fn);return b;}
function renderPay(){
  var box=$('pay-box');while(box.firstChild)box.removeChild(box.firstChild);
  if(S.draft&&S.draft.fee!==undefined&&S.draft.fee!==null)$('payment-amount').textContent=baht(pay&&pay.amount!=null?pay.amount:S.draft.fee);
  $('back-to-2').hidden=!!(pay||!S.draft||S.draft.status!=='DRAFT');
  if(!pay){box.appendChild(btn('create-qr-btn','สร้าง QR',createQr));stopPoll();return;}
  var st=pay.status||'PENDING';
  if(st!=='PAID'){
    var q=el('div',{'class':'qr','data-testid':'qr-image',role:'img','aria-label':'QR ชำระเงินจำลอง เลขอ้างอิง '+pay.ref});q.innerHTML=qrSvg(pay.ref);box.appendChild(q);
    var p1=el('p');p1.appendChild(document.createTextNode('เลขอ้างอิง: '));p1.appendChild(el('strong',{'data-testid':'qr-ref'},pay.ref));box.appendChild(p1);
    if(pay.qrExpiresAt){var p2=el('p');p2.appendChild(el('time',{'data-testid':'qr-expires','data-iso':pay.qrExpiresAt,datetime:pay.qrExpiresAt},'หมดอายุ '+fmt(pay.qrExpiresAt)));box.appendChild(p2);}
  }
  var p3=el('p');p3.appendChild(document.createTextNode('สถานะการชำระ: '));
  p3.appendChild(el('strong',{'data-testid':'payment-status','data-status':st,'class':'badge'},PAY_TH[st]||st));box.appendChild(p3);
  if(st==='EXPIRED'){
    box.appendChild(el('p',{'data-testid':'qr-expired-msg',role:'alert','class':'error'},'QR หมดอายุ กรุณาสร้าง QR ใหม่'));
    box.appendChild(btn('regenerate-qr-btn','สร้าง QR ใหม่',createQr));stopPoll();
  }else if(st==='PENDING'){
    var a=el('div',{'class':'actions'});a.appendChild(btn('refresh-payment-btn','ตรวจสอบการชำระเงิน',function(){refreshPay();}));box.appendChild(a);startPoll();
  }else if(st==='PAID'){
    stopPoll();
    var dl=el('dl',{'class':'kv'});
    function row(label,node){dl.appendChild(el('dt',null,label));var dd=el('dd');dd.appendChild(node);dl.appendChild(dd);}
    row('เลขคำขอ',el('span',{'data-testid':'submitted-case-no'},pay.caseNo||''));
    row('เลขใบเสร็จ',el('span',{'data-testid':'receipt-no'},pay.receiptNo||''));
    row('ยอดชำระ',el('span',{'data-testid':'receipt-amount'},baht(pay.amount)));
    row('ชำระเมื่อ',pay.paidAt?el('time',{'data-testid':'receipt-paid-at','data-iso':pay.paidAt,datetime:pay.paidAt},fmt(pay.paidAt)):el('span',{'data-testid':'receipt-paid-at'},'\\u2013'));
    box.appendChild(dl);
    var go2=el('a',{'class':'btn','data-testid':'go-case-btn',href:'/citizen/cases/'+encodeURIComponent(pay.caseNo||'')},'ดูคำขอ');
    var pa=el('p');pa.appendChild(go2);box.appendChild(pa);
  }
}
function mergePay(p){if(!p)return;pay=Object.assign({},pay||{},p);}
function createQr(){
  if(!S.draft)return;showMsg('wiz-error','');
  var b=this;if(b&&b.disabled!==undefined)b.disabled=true;
  api('POST','/api/drafts/'+encodeURIComponent(S.draft.draftId)+'/payment').then(function(r){
    if(r.status===201||r.status===200){pay={ref:r.data.ref,amount:r.data.amount,status:r.data.status||'PENDING',qrCreatedAt:r.data.qrCreatedAt,qrExpiresAt:r.data.qrExpiresAt};
      if(S.draft)S.draft.status='PENDING_PAYMENT';renderPay();}
    else{if(b)b.disabled=false;var m=errText(r);if(r.data&&r.data.missing&&r.data.missing.length&&r.data.code==='MISSING_DOCS')m='ยังขาดเอกสาร: '+r.data.missing.join(', ');showMsg('wiz-error',m);}
  });
}
function refreshPay(){
  if(!pay||!pay.ref)return Promise.resolve();
  var ref=pay.ref;
  return api('GET','/api/payments/'+encodeURIComponent(ref)).then(function(r){
    if(!pay||pay.ref!==ref)return;
    if(r.status===200&&r.data){mergePay(r.data);}
    if(r.status===200&&r.data&&r.data.status==='PAID'&&!r.data.paidAt||r.status!==200){
      return api('GET','/api/drafts/'+encodeURIComponent(S.draft.draftId)).then(function(d){
        if(d.status===200&&d.data&&d.data.payment&&d.data.payment.ref===ref){var dp=d.data.payment;
          if(r.status===200&&r.data){if(!pay.paidAt&&dp.paidAt)pay.paidAt=dp.paidAt;if(!pay.receiptNo&&dp.receiptNo)pay.receiptNo=dp.receiptNo;if(!pay.caseNo&&dp.caseNo)pay.caseNo=dp.caseNo;}
          else mergePay(dp);}
      });
    }
  }).then(function(){renderPay();});
}
function startPoll(){if(!pollTimer)pollTimer=setInterval(function(){refreshPay();},3000);}
function stopPoll(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
$('back-to-2').addEventListener('click',function(){go(2);});

// ---------- สลับขั้น ----------
function go(n){
  S.step=n;[1,2,3].forEach(function(i){$('step-'+i).hidden=(i!==n);});
  $('wiz-step').textContent=STEP_TEXT[n];
  if(n===2)renderFiles();
  if(n===3){pay=S.draft&&S.draft.payment?Object.assign({},S.draft.payment):pay;renderPay();if(pay&&pay.status!=='PAID')refreshPay();}
  if(n!==3)stopPoll();
  var h=$('h-step-'+n);if(h)h.focus();
}
// เริ่มต้น
if(S.draft){$('draft-id-wrap').hidden=false;}
if(S.step===2)renderFiles();
if(S.step===3){pay=S.draft&&S.draft.payment?Object.assign({},S.draft.payment):null;renderPay();if(pay&&pay.status!=='PAID')refreshPay();}
})();`;

// ───────────────────────── ลงทะเบียน route ─────────────────────────
function register(app, ctx) {
  const r = express.Router();
  const citizenPage = auth.requirePage('citizen');
  const citizenApi = auth.requireApi('citizen');

  // หน้า
  r.get('/citizen', citizenPage, citizenHome);
  r.get('/citizen/new/:service', citizenPage, wizardPage);
  r.get('/citizen/cases/:caseNo', citizenPage, (req, res) => {
    const done = req.query.done;
    caseView(req, res, { success: done === 'cancel' ? 'ยกเลิกคำขอแล้ว' : done === 'fix' ? 'ส่งแก้ไขเรียบร้อยแล้ว' : undefined });
  });
  r.post('/citizen/cases/:caseNo/cancel', citizenPage, (req, res) => {
    const out = cancelCase(req.user, req.params.caseNo);
    if (out.ok) return res.redirect(303, `/citizen/cases/${encodeURIComponent(req.params.caseNo)}?done=cancel`);
    if (out.status === 404) return auth.notFoundPage(req, res);
    return caseView(req, res, { error: out.message, status: out.status });
  });
  r.post('/citizen/cases/:caseNo/resubmit', citizenPage, async (req, res, next) => {
    try {
      const upErr = await runUpload(req, res);
      const c = getCase(req.params.caseNo);
      if (!c || c.user_id !== req.user.id) return auth.notFoundPage(req, res);
      if (upErr) return caseView(req, res, { error: upErr.message, status: upErr.status });
      const out = resubmitCase(req.user, req.params.caseNo, pickedFiles(req));
      if (out.ok) return res.redirect(303, `/citizen/cases/${encodeURIComponent(req.params.caseNo)}?done=fix`);
      if (out.status === 404) return auth.notFoundPage(req, res);
      return caseView(req, res, { error: out.message, status: out.status });
    } catch (e) { next(e); }
  });

  // ค่าธรรมเนียม (ไม่สร้างข้อมูล)
  r.get('/api/fee-quote', citizenApi, (req, res) => {
    const svc = serviceRow(String(req.query.serviceId || ''));
    if (!svc) return res.json({ ok: false, code: 'INVALID_SERVICE', message: MSG.INVALID_SERVICE });
    const input = {};
    if (req.query.qty !== undefined) input.qty = String(req.query.qty);
    if (req.query.areaSqm !== undefined) input.areaSqm = String(req.query.areaSqm);
    const calc = rules.calcFee(svc, input, db);
    if (!calc.ok) return res.json({ ok: false, code: calc.code, message: calc.message });
    return res.json({ ok: true, fee: calc.fee });
  });

  // ร่าง
  r.post('/api/drafts', citizenApi, (req, res) => {
    const out = createDraft(req.user, req.body || {});
    if (!out.ok) return sendErr(res, out);
    const d = out.draft;
    return res.status(201).json({ draftId: d.id, fee: d.fee, serviceId: d.service_id, status: d.status });
  });
  r.get('/api/drafts', citizenApi, (req, res) => {
    const rows = db.prepare(`SELECT * FROM drafts WHERE user_id = ? AND status IN ('DRAFT','PENDING_PAYMENT') AND case_no IS NULL
      ORDER BY id`).all(req.user.id).filter((d) => !isPaidDraft(d));
    res.json({ items: rows.map((d) => ({ draftId: d.id, serviceId: d.service_id, status: d.status, fee: draftFee(d) })) });
  });
  r.get('/api/drafts/:id', citizenApi, (req, res) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return notFoundApi(res);
    res.json(draftJson(d));
  });
  r.put('/api/drafts/:id', citizenApi, (req, res) => {
    const out = updateDraft(req.user, req.params.id, req.body || {});
    if (!out.ok) return sendErr(res, out);
    res.json({ draftId: out.draft.id, fee: out.draft.fee, serviceId: out.draft.service_id, status: out.draft.status });
  });
  r.delete('/api/drafts/:id', citizenApi, (req, res) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return notFoundApi(res);
    if (isPaidDraft(d)) return auth.apiError(res, 409, 'INVALID_STATE', MSG.INVALID_STATE);
    const files = deleteDraftTx(d);
    files.forEach((f) => unlinkStored(f.storage_name));
    res.status(204).end();
  });

  // ไฟล์แนบของร่าง
  r.post('/api/drafts/:id/files', citizenApi, async (req, res, next) => {
    try {
      const upErr = await runUpload(req, res);
      // ร่างของคนอื่น/ไม่มี → 404 ก่อนบอกผลตรวจไฟล์ (ไม่เผยว่ามีอยู่)
      if (!ownDraft(req.user, req.params.id)) return notFoundApi(res);
      if (upErr) return sendErr(res, upErr);
      const files = pickedFiles(req);
      const docKey = String((req.body && (req.body.docKey || req.body.doc_key)) || '');
      if (files.length > 1) {
        // หลายไฟล์ในคำขอเดียว: แนบทีละไฟล์ หยุดที่ไฟล์แรกที่ผิด
        const added = [];
        for (const f of files) {
          const out = addDraftFile(req.user, req.params.id, docKey, f);
          if (!out.ok) return sendErr(res, { ...out, extra: { ...(out.extra || {}), added } });
          added.push(out.file);
        }
        return res.status(201).json({ ...added[0], items: added });
      }
      const out = addDraftFile(req.user, req.params.id, docKey, files[0]);
      if (!out.ok) return sendErr(res, out);
      return res.status(201).json(out.file);
    } catch (e) { next(e); }
  });
  r.delete('/api/drafts/:id/files/:fileId', citizenApi, (req, res) => {
    const d = ownDraft(req.user, req.params.id);
    if (!d) return notFoundApi(res);
    if (isPaidDraft(d)) return auth.apiError(res, 409, 'INVALID_STATE', MSG.INVALID_STATE);
    const f = db.prepare('SELECT * FROM files WHERE id = ? AND draft_id = ?').get(req.params.fileId, d.id);
    if (!f) return auth.apiError(res, 404, 'NOT_FOUND', 'ไม่พบไฟล์');
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    unlinkStored(f.storage_name);
    res.status(204).end();
  });

  // คำขอ
  r.get('/api/cases', citizenApi, (req, res) => {
    const rows = db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY case_no DESC').all(req.user.id);
    res.json({ items: rows.map((c) => ({ caseNo: c.case_no, serviceId: c.service_id, status: c.status, dueAt: c.due_at ? clock.toIso(c.due_at) : null, slaLevel: safeSla(c).level })) });
  });
  r.get('/api/cases/:caseNo', auth.requireApi('citizen', 'officer', 'head'), (req, res) => {
    const c = getCase(req.params.caseNo);
    if (req.user.role === 'citizen') {
      if (!viewableByCitizen(req.user, c)) return notFoundApi(res);
      return res.json(caseJson(c, true));
    }
    if (!c) return notFoundApi(res);
    return res.json(caseJson(c, false));
  });
  r.post('/api/cases/:caseNo/cancel', citizenApi, (req, res) => {
    const out = cancelCase(req.user, req.params.caseNo);
    if (!out.ok) return sendErr(res, out);
    res.json({ status: 'CANCELLED' });
  });
  r.post('/api/cases/:caseNo/resubmit', citizenApi, async (req, res, next) => {
    try {
      const upErr = await runUpload(req, res);
      const c = getCase(req.params.caseNo);
      if (!c || c.user_id !== req.user.id) return notFoundApi(res);
      if (upErr) return sendErr(res, upErr);
      const out = resubmitCase(req.user, req.params.caseNo, pickedFiles(req));
      if (!out.ok) return sendErr(res, out);
      res.json({ status: out.status, dueAt: out.dueAt });
    } catch (e) { next(e); }
  });

  app.use(r);

  // สำรอง: ยกเลิกอัตโนมัติเมื่อเลย 168 ชม. (A-46 · idempotent กับ hook ของบล็อกเจ้าหน้าที่)
  const hooks = (ctx && ctx.hooks) || require('../lib/hooks');
  hooks.onEveryRequest(() => {
    try { sweepExpiredFixes(); } catch (e) { console.error('[citizen] auto-cancel sweep:', e.message); }
  }, { order: 15 });
}

module.exports = register;
Object.assign(module.exports, {
  // ให้บล็อกอื่นใช้ซ้ำได้ (ไม่บังคับ)
  sniff, checkFile, serviceDocs, missingDocs, draftFiles, caseFiles, caseJson, fixDeadlineOf, expireIfDue, sweepExpiredFixes,
  MAX_FILE_BYTES, MAX_FILES, MSG,
});
