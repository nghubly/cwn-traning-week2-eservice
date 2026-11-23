'use strict';
/**
 * B06 · ชำระเงิน PromptPay QR จำลอง + ออกเลขคำขอ + ใบเสร็จ
 * REQUIREMENTS FR-08 · BR-09 BR-10 BR-11 (BR-12 ผ่าน rules.js) · CONTRACT §2.5 §5 §6.2 §8 · DECISIONS §6 §7 §18 (A-42)
 * BUG_MODE: B05 (QR อายุ 15:00 พอดียังจ่ายได้: ใช้ `≤` แทน `<`)
 *
 * ── API ──
 *   POST /api/drafts/:id/payment          citizen เจ้าของ → 201 {ref, amount, status:"PENDING", qrCreatedAt, qrExpiresAt}
 *                                         · ขาดเอกสารบังคับ → 409 MISSING_DOCS {missing:[...]} · ชำระแล้ว → 409 INVALID_STATE
 *                                         · ร่างของคนอื่น/ไม่มี → 404 · สร้างซ้ำได้ (ref ใหม่ · QR เดิมที่ยังค้างถูกยกเลิก)
 *   GET  /api/payments/:ref               citizen เจ้าของ → 200 {ref, amount, status PENDING|PAID|EXPIRED, qrCreatedAt, qrExpiresAt,
 *                                         caseNo, receiptNo, paidAt} · ไม่มี/ของคนอื่น → 404
 *   GET  /api/receipts/:receiptNo         citizen เจ้าของ → 200 {receiptNo, caseNo, amount, paidAt, ref, serviceId} (ไม่อยู่ใน CONTRACT)
 *   POST /api/test/payments/:ref/pay      (TEST_MODE · ไม่ต้องล็อกอิน = ธนาคารจำลองยิง callback) {amount}
 *                                         → 200 {status:"PAID", caseNo, receiptNo, duplicate, paidAt}
 *                                         · 410 QR_EXPIRED · 422 AMOUNT_MISMATCH · 404 ไม่มี ref
 *
 * กฎ:
 *   - ยอดถูกล็อกตอนร่างเข้า PENDING_PAYMENT (สร้าง QR ครั้งแรก) → drafts.fee_locked · QR ใหม่ของร่างเดิมใช้ยอดที่ล็อก (A-42)
 *   - QR ใช้ได้ถ้า (เวลาชำระ − เวลาสร้าง) < 15:00 (B05: ≤ 15:00) · เวลาอ่านจาก lib/clock เท่านั้น
 *   - callback ซ้ำ ref ที่ชำระแล้ว → 200 duplicate:true เลขเดิม (ไม่สร้างคำขอ/ไม่ขยับตัวนับ) แม้ QR จะหมดอายุไปแล้ว
 *   - เลข EG-<พ.ศ.ของเวลาชำระ>-<6 หลัก> และ RC-<พ.ศ.>-<6 หลัก> ออกใน transaction เดียว (BEGIN IMMEDIATE) → ชำระพร้อมกันไม่ซ้ำ
 *   - กำหนดเสร็จคำนวณครั้งเดียวตอนชำระด้วย rules.calcDueAtForService (B03 อยู่ใน rules.js)
 *   - การกระทำของประชาชน/ธนาคารไม่เขียน audit_log (TC-AUDIT-01 นับเฉพาะเหตุการณ์เจ้าหน้าที่) · เขียน case_events SUBMIT แทน
 */
const express = require('express');

const dbm = require('../db');
const clock = require('../lib/clock');
const bug = require('../lib/bugmode');
const rules = require('../lib/rules');
const auth = require('./auth');

const { db } = dbm;

const QR_TTL_MS = 15 * 60 * 1000; // 15:00 นาที (A-15)

const MSG = {
  NOT_FOUND: 'ไม่พบคำขอ',
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  MISSING_DOCS_PREFIX: 'ยังขาดเอกสาร: ',
};

// เอกสารบังคับตาม CONTRACT 4.3 (ใช้เมื่อโหลด citizen.js / ตาราง service_docs ไม่ได้)
const REQUIRED_FALLBACK = {
  'SV-01': [['id-card', 'บัตรประชาชน']],
  'SV-02': [['id-card', 'บัตรประชาชน'], ['map', 'แผนที่ตั้ง']],
  'SV-03': [['id-card', 'บัตรประชาชน'], ['plan', 'แบบแปลน'], ['deed', 'โฉนด']],
};

let citizenLib = null;
try { citizenLib = require('./citizen'); } catch { citizenLib = null; }

const pad = (n, w) => String(n).padStart(w, '0');
const err = (status, code, message, extra) => ({ ok: false, status, code, message: message || MSG[code] || code, extra });
const sendErr = (res, e) => auth.apiError(res, e.status, e.code, e.message, e.extra);

// ───────────────────────── อายุ QR (BR-10 · B05) ─────────────────────────
/** QR หมดอายุแล้วหรือยัง ณ เวลา at: อายุ ≥ 15:00 → หมด · B05: อายุ > 15:00 เท่านั้น */
function isQrExpired(createdAt, at = clock.now()) {
  const age = clock.cmp(at, createdAt);
  return bug.isBug('B05') ? age > QR_TTL_MS : age >= QR_TTL_MS;
}

/** สถานะที่ส่งออก: PAID · VOID (ถูกแทนด้วย QR ใหม่) = EXPIRED · PENDING ที่เลยอายุ = EXPIRED */
function paymentStatus(p, at = clock.now()) {
  if (p.status === 'PAID') return 'PAID';
  if (p.status === 'VOID') return 'EXPIRED';
  return isQrExpired(p.qr_created_at, at) ? 'EXPIRED' : 'PENDING';
}

function paymentJson(p) {
  return {
    ref: p.ref,
    amount: p.amount,
    status: paymentStatus(p),
    qrCreatedAt: clock.toIso(p.qr_created_at),
    qrExpiresAt: clock.toIso(p.qr_expires_at),
    caseNo: p.case_no || null,
    receiptNo: p.receipt_no || null,
    paidAt: p.paid_at ? clock.toIso(p.paid_at) : null,
  };
}

// ───────────────────────── ร่าง ─────────────────────────
function getDraft(id) {
  return typeof id === 'string' ? db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) || null : null;
}
function ownDraft(user, id) {
  const d = getDraft(id);
  if (!d || d.status === 'DELETED' || !user || d.user_id !== user.id) return null;
  return d;
}
function isPaidDraft(d) {
  if (d.status === 'SUBMITTED' || d.case_no) return true;
  return !!db.prepare("SELECT 1 FROM payments WHERE draft_id = ? AND status = 'PAID' LIMIT 1").get(d.id);
}

/** ชื่อเอกสารบังคับที่ยังไม่แนบ (เรียงตามตาราง 4.3) */
function missingDocs(d) {
  if (citizenLib && typeof citizenLib.missingDocs === 'function' && typeof citizenLib.draftFiles === 'function') {
    return citizenLib.missingDocs(d.service_id, citizenLib.draftFiles(d.id));
  }
  const have = new Set(db.prepare('SELECT doc_key FROM files WHERE draft_id = ?').all(d.id).map((f) => f.doc_key));
  let req = [];
  try {
    req = db.prepare('SELECT doc_key, label FROM service_docs WHERE service_id = ? AND required = 1 ORDER BY sort, rowid')
      .all(d.service_id).map((r) => [r.doc_key, r.label]);
  } catch { req = []; }
  if (!req.length) req = REQUIRED_FALLBACK[d.service_id] || [];
  return req.filter(([key]) => !have.has(key)).map(([, label]) => label);
}

/** ยอดที่ต้องชำระ: PENDING_PAYMENT = ยอดที่ล็อก · DRAFT = คิดจากค่าธรรมเนียมปัจจุบัน (จะถูกล็อกตอนนี้) */
function amountFor(d) {
  if (d.status === 'PENDING_PAYMENT') {
    const locked = d.fee_locked != null ? d.fee_locked : d.fee;
    return { ok: true, fee: locked, lock: false };
  }
  const input = {};
  if (d.service_id === 'SV-01' && d.qty != null) input.qty = d.qty;
  if (d.service_id === 'SV-03') input.areaSqm = d.area_sqm;
  const r = rules.calcFee(d.service_id, input, db);
  if (!r.ok) return err(r.status || 400, r.code, r.message);
  return { ok: true, fee: r.fee, lock: true };
}

/** สร้าง QR (ref ใหม่ทุกครั้ง) · ล็อกยอดเมื่อร่างยังเป็น DRAFT · ยกเลิก QR ที่ค้างของร่างเดียวกัน */
const createQrTx = db.transaction((draftId, userId) => {
  const d = getDraft(draftId);
  if (!d || d.status === 'DELETED' || d.user_id !== userId) return err(404, 'NOT_FOUND');
  if (isPaidDraft(d) || !['DRAFT', 'PENDING_PAYMENT'].includes(d.status)) return err(409, 'INVALID_STATE');
  const missing = missingDocs(d);
  if (missing.length) return err(409, 'MISSING_DOCS', MSG.MISSING_DOCS_PREFIX + missing.join(', '), { missing });
  const amt = amountFor(d);
  if (!amt.ok) return amt;

  const now = clock.now();
  const createdAt = clock.toIso(now);
  const expiresAt = clock.toIso(clock.addMs(now, QR_TTL_MS));
  if (amt.lock) {
    db.prepare(`UPDATE drafts SET status = 'PENDING_PAYMENT', fee = ?, fee_locked = ?, locked_at = ?, updated_at = ? WHERE id = ?`)
      .run(amt.fee, amt.fee, createdAt, createdAt, d.id);
  } else if (d.fee_locked == null) {
    db.prepare('UPDATE drafts SET fee_locked = ?, locked_at = COALESCE(locked_at, ?), updated_at = ? WHERE id = ?')
      .run(amt.fee, createdAt, createdAt, d.id);
  }
  db.prepare("UPDATE payments SET status = 'VOID' WHERE draft_id = ? AND status = 'PENDING'").run(d.id);
  const ref = `PP-${pad(dbm.nextSeq('payment'), 4)}`;
  db.prepare(`INSERT INTO payments (ref, draft_id, amount, status, qr_created_at, qr_expires_at, paid_at, case_no, receipt_no)
    VALUES (?, ?, ?, 'PENDING', ?, ?, NULL, NULL, NULL)`).run(ref, d.id, amt.fee, createdAt, expiresAt);
  return { ok: true, payment: db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref) };
});

// ───────────────────────── เลขรัน (BR-09) ─────────────────────────
/** เลขถัดไปของตัวนับ · ถ้าตัวนับตามหลังข้อมูลจริง (ไม่ได้ตั้งไว้) กระโดดไปเลขถัดจากค่าสูงสุดที่มี */
function allocSeq(counter, floor) {
  let seq = dbm.nextSeq(counter);
  if (seq <= floor) {
    seq = floor + 1;
    dbm.setSeq(counter, seq);
  }
  return seq;
}
function maxCaseSeq(yearBe) {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM cases WHERE year_be = ?').get(yearBe).m;
}
function maxReceiptSeq(yearBe) {
  const prefix = `RC-${yearBe}-`;
  return db.prepare('SELECT COALESCE(MAX(CAST(substr(receipt_no, ?) AS INTEGER)), 0) AS m FROM receipts WHERE receipt_no LIKE ?')
    .get(prefix.length + 1, `${prefix}%`).m;
}

// ───────────────────────── callback ชำระเงิน ─────────────────────────
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

function paidResult(p, duplicate) {
  return {
    ok: true,
    body: { status: 'PAID', caseNo: p.case_no, receiptNo: p.receipt_no, duplicate, paidAt: p.paid_at ? clock.toIso(p.paid_at) : null },
  };
}

/**
 * ทั้งหมดอยู่ใน transaction เดียว (เรียกด้วย .immediate → BEGIN IMMEDIATE จองสิทธิ์เขียนก่อนอ่าน)
 * ลำดับตรวจ: ไม่มี ref 404 → ชำระแล้ว (duplicate) → QR หมดอายุ/ถูกแทน 410 → ยอดไม่ตรง 422 → ออกเลข
 */
const payTx = db.transaction((ref, rawAmount) => {
  const p = typeof ref === 'string' ? db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref) : null;
  if (!p) return err(404, 'NOT_FOUND');
  const d = getDraft(p.draft_id);
  if (!d || d.status === 'DELETED') return err(404, 'NOT_FOUND');

  if (p.status === 'PAID') return paidResult(p, true);

  const now = clock.now();
  if (p.status === 'VOID' || isQrExpired(p.qr_created_at, now)) return err(410, 'QR_EXPIRED');

  const amount = parseAmount(rawAmount);
  if (!(amount === p.amount)) return err(422, 'AMOUNT_MISMATCH');

  // ร่างนี้ชำระด้วย ref อื่นไปแล้ว (ปกติ QR เก่าถูก VOID แล้ว · กันไว้อีกชั้น ไม่ให้เกิดคำขอซ้ำ)
  if (isPaidDraft(d)) return err(409, 'INVALID_STATE');

  const paidAt = clock.toIso(now);
  const yearBe = clock.beYear(now);
  const seq = allocSeq(`case:${yearBe}`, maxCaseSeq(yearBe));
  const caseNo = `EG-${yearBe}-${pad(seq, 6)}`;
  const rseq = allocSeq(`receipt:${yearBe}`, Math.max(maxReceiptSeq(yearBe), seq - 1));
  const receiptNo = `RC-${yearBe}-${pad(rseq, 6)}`;
  const dueAt = rules.calcDueAtForService(d.service_id, paidAt, db); // BR-12 · คำนวณครั้งเดียว

  db.prepare(`INSERT INTO cases (case_no, year_be, seq, draft_id, user_id, service_id, qty, area_sqm, fee, status, dept, step,
      owner, issuer, registry_officer, works_officer, return_count, paid_at, due_at, need_fix_at, fix_deadline,
      approved_by, approved_at, closed_at, cancelled_at, cancel_reason, receipt_no, payment_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 'registry', ?, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`)
    .run(caseNo, yearBe, seq, d.id, d.user_id, d.service_id,
      d.service_id === 'SV-01' ? d.qty : null, d.service_id === 'SV-03' ? d.area_sqm : null, p.amount,
      d.service_id === 'SV-03' ? 1 : null, paidAt, dueAt, receiptNo, p.ref, paidAt, paidAt);
  db.prepare('INSERT INTO receipts (receipt_no, case_no, payment_ref, amount, issued_at) VALUES (?, ?, ?, ?, ?)')
    .run(receiptNo, caseNo, p.ref, p.amount, paidAt);
  db.prepare("UPDATE payments SET status = 'PAID', paid_at = ?, case_no = ?, receipt_no = ? WHERE ref = ?")
    .run(paidAt, caseNo, receiptNo, p.ref);
  db.prepare("UPDATE payments SET status = 'VOID' WHERE draft_id = ? AND status = 'PENDING' AND ref <> ?").run(d.id, p.ref);
  db.prepare(`UPDATE drafts SET status = 'SUBMITTED', case_no = ?, fee_locked = COALESCE(fee_locked, ?),
      locked_at = COALESCE(locked_at, ?), updated_at = ? WHERE id = ?`)
    .run(caseNo, p.amount, paidAt, paidAt, d.id);
  db.prepare('UPDATE files SET case_no = ? WHERE draft_id = ? AND case_no IS NULL').run(caseNo, d.id);
  db.prepare(`INSERT INTO case_events (case_no, time, actor, event, from_status, to_status, note)
    VALUES (?, ?, 'citizen', 'SUBMIT', NULL, 'SUBMITTED', ?)`).run(caseNo, paidAt, `ชำระเงินแล้ว ใบเสร็จ ${receiptNo}`);

  return paidResult(db.prepare('SELECT * FROM payments WHERE ref = ?').get(p.ref), false);
});

/** ชำระ ref (ใช้ใน test hook · บล็อกอื่นเรียกซ้ำได้) → {ok, body} หรือ {ok:false, status, code, message} */
function payRef(ref, amount) {
  return payTx.immediate(ref, amount);
}

/** สร้าง QR ให้ร่างของผู้ใช้ → {ok, payment} หรือ error */
function createQr(user, draftId) {
  if (!user) return err(404, 'NOT_FOUND');
  return createQrTx.immediate(String(draftId), user.id);
}

/** payment ของ ref ที่ผู้ใช้เป็นเจ้าของร่าง หรือ null */
function ownPayment(user, ref) {
  const p = typeof ref === 'string' ? db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref) : null;
  if (!p) return null;
  const d = getDraft(p.draft_id);
  if (!d || d.status === 'DELETED' || !user || d.user_id !== user.id) return null;
  return p;
}

// ───────────────────────── ลงทะเบียน route ─────────────────────────
function register(app) {
  const r = express.Router();
  const citizenApi = auth.requireApi('citizen');

  r.post('/api/drafts/:id/payment', citizenApi, (req, res, next) => {
    try {
      const out = createQr(req.user, req.params.id);
      if (!out.ok) return sendErr(res, out);
      return res.status(201).json(paymentJson(out.payment));
    } catch (e) { return next(e); }
  });

  r.get('/api/payments/:ref', citizenApi, (req, res) => {
    const p = ownPayment(req.user, req.params.ref);
    if (!p) return auth.apiError(res, 404, 'NOT_FOUND', MSG.NOT_FOUND);
    return res.json(paymentJson(p));
  });

  r.get('/api/receipts/:receiptNo', citizenApi, (req, res) => {
    const rc = db.prepare(`SELECT r.receipt_no, r.case_no, r.amount, r.issued_at, r.payment_ref, c.service_id, c.user_id
      FROM receipts r JOIN cases c ON c.case_no = r.case_no WHERE r.receipt_no = ?`).get(String(req.params.receiptNo));
    if (!rc || rc.user_id !== req.user.id) return auth.apiError(res, 404, 'NOT_FOUND', MSG.NOT_FOUND);
    return res.json({
      receiptNo: rc.receipt_no, caseNo: rc.case_no, amount: rc.amount, paidAt: clock.toIso(rc.issued_at),
      ref: rc.payment_ref || null, serviceId: rc.service_id,
    });
  });

  // test hook (app.js ตอบ 404 ให้ /api/test/* เมื่อไม่ได้ตั้ง TEST_MODE=1)
  r.post('/api/test/payments/:ref/pay', (req, res, next) => {
    try {
      const out = payRef(req.params.ref, req.body ? req.body.amount : undefined);
      if (!out.ok) return sendErr(res, out);
      return res.status(200).json(out.body);
    } catch (e) { return next(e); }
  });

  app.use(r);
}

module.exports = register;
Object.assign(module.exports, {
  QR_TTL_MS, MSG, isQrExpired, paymentStatus, paymentJson, createQr, payRef, ownPayment,
});
