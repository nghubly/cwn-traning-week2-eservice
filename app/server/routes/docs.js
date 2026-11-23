'use strict';
/**
 * B09 · เอกสารดิจิทัล (HMAC-SHA256) + หน้าตรวจเอกสาร /verify
 *
 * อ้างอิง: REQUIREMENTS BR-23 · CONTRACT §1 §2.13 §3 §5 §6.4 §8 · DECISIONS §10 · TEST-DATA §5 · A-22 A-23 A-43 A-48 A-54 A-63
 *
 * Route ที่ไฟล์นี้ประกาศ
 *   GET  /verify                          ฟอร์มกรอกรหัส (ไม่ต้องล็อกอิน)
 *   GET  /verify/:code                    ผลตรวจ (ไม่ต้องล็อกอิน) · พบ = 200 · ไม่พบ = 404
 *   GET  /api/verify/:code                200 {result:VALID|EXPIRED, docNo, applicantMasked, serviceId, issuedAt, validUntil, signer}
 *                                         200 {result:'TAMPERED'} · 404 {result:'NOT_FOUND'}
 *   GET  /api/documents/:docNo/pdf        citizen เจ้าของ · officer/head = 200 · citizen คนอื่น/ไม่มี = 404 · บทบาทอื่น 403 · anon 401
 *   POST /api/test/documents/:docNo/tamper (TEST_MODE) แก้ payload ที่เก็บโดยไม่คำนวณลายเซ็นใหม่ → 200 {ok:true} · ไม่มี → 404
 *
 * ใช้จากบล็อกอื่น
 *   require('./docs').createDocument({db, caseRow, issuer, now}) → {docNo, verifyCode}
 *     officer.js (B07) เรียกใน transaction ของ POST /api/officer/cases/:caseNo/issue
 *     ไฟล์นี้ "ไม่" เขียน audit และ "ไม่" เปลี่ยนสถานะคำขอ (officer.js ทำ ISSUE audit + COMPLETED เอง)
 *   .verifyDocument(code, now?) · .validUntilFor(serviceId, issuedAt) · .maskApplicant(name) · .renderPdf(docRow)
 *
 * ลายเซ็น = HMAC-SHA256 ของ docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer ด้วย DOC_HMAC_KEY → base64url
 * (สูตรเดียวกับ seed.docSignature ที่ใช้ลงนาม DOC-2569-000001)
 * ลำดับตรวจ (A-43): ไม่พบ → NOT_FOUND · ลายเซ็นไม่ตรง → TAMPERED (แม้หมดอายุด้วย) · วันนี้ > ใช้ได้ถึง → EXPIRED · อื่น ๆ VALID
 */
const crypto = require('crypto');
const express = require('express');

const clock = require('../lib/clock');
const format = require('../lib/format');
const { html, raw } = require('../lib/html');
const dbm = require('../db');
const seed = require('../seed');
const auth = require('./auth');

const { docSignature, SIGN_FIELDS } = seed;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_RE = /^[A-Z0-9]{8}$/;
const DOC_NO_RE = /^DOC-\d{4}-\d{6}$/;
const BASE_URL = String(process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

const RESULT_TH = {
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
};

// ───────────────────────── วันที่ (date-only arithmetic · ไม่อ่านเวลาเครื่อง) ─────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');
function ymd(y, m, d) {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}
function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
/** 'YYYY-MM-DD' + n วัน (ปฏิทิน) */
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * วันสุดท้ายที่ใช้ได้ (BR-23 · A-23 · A-43) จากวันออกตามเวลาไทย
 *   SV-01: ออก + 89 วัน (90 วันนับวันออก)
 *   SV-02/03: วันครบรอบปีถัดไป − 1 วัน · ออก 29 ก.พ. แล้วปีถัดไปไม่มี 29 ก.พ. → ใช้ 28 ก.พ. เป็นวันครบรอบ
 */
function validUntilFor(serviceId, issuedAt) {
  const p = clock.parts(issuedAt);
  if (serviceId === 'SV-01') return addDays(p.date, 89);
  const y = p.y + 1;
  const d = p.m === 2 && p.d === 29 && !isLeap(y) ? 28 : p.d;
  return addDays(ymd(y, p.m, d), -1);
}

/** หมดอายุตั้งแต่ 00:00 ของวันถัดจาก validUntil (เวลาไทย) */
function isExpired(validUntil, now = clock.now()) {
  return clock.dateKey(now) > String(validUntil);
}

// ───────────────────────── ปิดบังชื่อ (BR-23 · A-54) ─────────────────────────

/** "สมชาย ใจดี" → "สมชาย ใ***" · ไม่มีนามสกุล → "ชื่อ ***" */
function maskApplicant(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '***';
  if (parts.length === 1) return `${parts[0]} ***`;
  const last = parts.pop();
  return `${parts.join(' ')} ${Array.from(last)[0]}***`;
}

// ───────────────────────── ออกเอกสาร ─────────────────────────

function newVerifyCode(db) {
  const has = db.prepare('SELECT 1 FROM documents WHERE verify_code = ?');
  for (let t = 0; t < 100; t++) {
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!has.get(s)) return s;
  }
  throw new Error('docs: cannot allocate verify code');
}

function staffName(db, username) {
  if (!username) return '';
  const r = db.prepare('SELECT name FROM users WHERE username = ?').get(username);
  return r && r.name ? r.name : username;
}

function applicantNameOf(db, c) {
  if (c.applicant_name) return c.applicant_name;
  const r = c.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(c.user_id) : null;
  return r ? r.name : '';
}

/**
 * สร้างแถว documents ของคำขอที่ APPROVED (ผู้เรียกตรวจสิทธิ์/สถานะแล้ว · เรียกใน transaction ได้)
 * ผู้ลงนาม = ผู้อนุมัติ (SV-01 เจ้าหน้าที่ · SV-02/03 หัวหน้าฝ่าย) · เลข DOC-<พ.ศ. ของเวลาออก>-<6 หลัก> เริ่มใหม่ทุกปี (A-48)
 * ไม่เขียน audit และไม่เปลี่ยนสถานะคำขอ
 */
function createDocument({ db = dbm.db, caseRow, issuer, now } = {}) {
  if (!caseRow || !caseRow.case_no) throw new Error('docs.createDocument: caseRow required');
  const c = caseRow;
  const issuedAt = clock.toIso(now || clock.now());
  const be = clock.beYear(issuedAt);
  const docNo = `DOC-${be}-${pad(dbm.nextSeq(`doc:${be}`), 6)}`;
  const verifyCode = newVerifyCode(db);
  const signerUsername = c.approved_by || (issuer && issuer.username) || c.issuer || null;
  const applicant = applicantNameOf(db, c);
  const payload = {
    docNo,
    caseNo: c.case_no,
    applicant,
    serviceId: c.service_id,
    issuedAt,
    validUntil: validUntilFor(c.service_id, issuedAt),
    signer: staffName(db, signerUsername),
  };
  db.prepare(`INSERT INTO documents (doc_no, case_no, verify_code, service_id, applicant_masked, issued_at, valid_until, signer,
      signer_username, payload, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(docNo, c.case_no, verifyCode, c.service_id, maskApplicant(applicant), issuedAt, payload.validUntil,
      payload.signer, signerUsername, JSON.stringify(payload), docSignature(payload));
  return { docNo, verifyCode };
}

// ───────────────────────── ตรวจเอกสาร ─────────────────────────

function parsePayload(row) {
  try {
    const p = JSON.parse(row.payload);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

function sameSig(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** ลายเซ็นตรงกับ payload ที่เก็บ และคอลัมน์ที่ใช้แสดงผลตรงกับ payload ที่ลงนาม */
function signatureOk(row, p) {
  if (!p) return false;
  if (!SIGN_FIELDS.every((k) => typeof p[k] === 'string')) return false;
  if (!sameSig(docSignature(p), row.signature)) return false;
  return p.docNo === row.doc_no && p.caseNo === row.case_no && p.serviceId === row.service_id
    && p.issuedAt === row.issued_at && p.validUntil === row.valid_until && p.signer === row.signer;
}

function serviceLabel(db, serviceId) {
  let name = '';
  try {
    const r = db.prepare('SELECT name FROM services WHERE id = ?').get(serviceId);
    name = r && r.name ? r.name : '';
  } catch { /* ignore */ }
  return `${serviceId} ${name || format.SERVICE_TH[serviceId] || ''}`.trim();
}

function normCode(code) {
  return String(code || '').trim().toUpperCase();
}

/** → {result, doc?} · doc มีเฉพาะ VALID/EXPIRED */
function verifyDocument(code, now = clock.now(), db = dbm.db) {
  const c = normCode(code);
  if (!CODE_RE.test(c)) return { result: 'NOT_FOUND' };
  const row = db.prepare('SELECT * FROM documents WHERE verify_code = ?').get(c);
  if (!row) return { result: 'NOT_FOUND' };
  const p = parsePayload(row);
  if (!signatureOk(row, p)) return { result: 'TAMPERED' };
  const doc = {
    docNo: p.docNo,
    applicantMasked: maskApplicant(p.applicant),
    serviceId: p.serviceId,
    serviceLabel: serviceLabel(db, p.serviceId),
    issuedAt: p.issuedAt,
    validUntil: p.validUntil,
    signer: p.signer,
  };
  return { result: isExpired(p.validUntil, now) ? 'EXPIRED' : 'VALID', doc };
}

function verifyJson(v) {
  if (v.result !== 'VALID' && v.result !== 'EXPIRED') return { result: v.result };
  const d = v.doc;
  return {
    result: v.result, docNo: d.docNo, applicantMasked: d.applicantMasked, serviceId: d.serviceId,
    issuedAt: d.issuedAt, validUntil: d.validUntil, signer: d.signer,
  };
}

// ───────────────────────── หน้า /verify ─────────────────────────

const PAGE_STYLE = `
.verify-card{max-width:40rem;border:1px solid #c9ced6;border-radius:.5rem;padding:1rem 1.25rem;background:#fff}
.verify-result{font-size:1.35rem;font-weight:700;padding:.6rem .9rem;border-radius:.4rem;margin:.25rem 0 1rem}
.verify-result[data-result=VALID]{background:#e6f4ea;color:#0b5a26;border:1px solid #0b5a26}
.verify-result[data-result=EXPIRED]{background:#fff4e0;color:#6b3d00;border:1px solid #6b3d00}
.verify-result[data-result=TAMPERED],.verify-result[data-result=NOT_FOUND]{background:#fdecea;color:#8a1c12;border:1px solid #8a1c12}
.verify-card dl{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem;margin:0}
.verify-card dt{font-weight:600}.verify-card dd{margin:0;overflow-wrap:anywhere}
.verify-form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end;margin-top:1rem}
.verify-form input{font:inherit;padding:.4rem .5rem;text-transform:uppercase}
@media (max-width:480px){.verify-card dl{grid-template-columns:1fr}}`;

function verifyForm(value = '') {
  return html`<form class="verify-form" method="get" action="/verify" role="search" aria-label="ตรวจเอกสารด้วยรหัส">
<label for="verify-code-input">รหัสตรวจสอบ 8 ตัว</label>
<input id="verify-code-input" name="code" maxlength="8" autocomplete="off" value="${value}" data-testid="verify-code-input">
<button type="submit" class="btn" data-testid="verify-submit">ตรวจสอบ</button></form>`;
}

function verifyPageBody(v) {
  const head = html`<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<p class="muted">เทศบาลนครสุขใจ (หน่วยงานสมมติ · ระบบจำลองเพื่อการทดสอบ)</p>`;
  const result = html`<p class="verify-result" data-testid="verify-result" data-result="${v.result}" role="status">${RESULT_TH[v.result]}</p>`;
  if (!v.doc) {
    const hint = v.result === 'TAMPERED'
      ? 'ข้อมูลเอกสารไม่ตรงกับลายเซ็นดิจิทัล เอกสารนี้อาจถูกแก้ไข กรุณาติดต่อหน่วยงานผู้ออกเอกสาร'
      : 'ไม่พบเอกสารตามรหัสนี้ กรุณาตรวจรหัสอีกครั้ง';
    return html`<style>${raw(PAGE_STYLE)}</style>${head}<section class="verify-card" aria-label="ผลการตรวจเอกสาร">${result}<p>${hint}</p></section>${verifyForm()}`;
  }
  const d = v.doc;
  return html`<style>${raw(PAGE_STYLE)}</style>${head}
<section class="verify-card" aria-label="ผลการตรวจเอกสาร">${result}
<dl>
<dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${d.docNo}</dd>
<dt>ชื่อผู้ยื่น</dt><dd data-testid="verify-applicant">${d.applicantMasked}</dd>
<dt>บริการ</dt><dd data-testid="verify-service">${d.serviceLabel}</dd>
<dt>วันที่ออก</dt><dd><time data-testid="verify-issued" data-iso="${d.issuedAt}" datetime="${d.issuedAt}">${clock.formatThai(d.issuedAt)}</time></dd>
<dt>ใช้ได้ถึง</dt><dd><time data-testid="verify-expires" data-iso="${d.validUntil}" datetime="${d.validUntil}">${clock.formatThaiDate(d.validUntil)}</time></dd>
<dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${d.signer}</dd>
</dl>
<p class="muted">ลายเซ็นดิจิทัลจำลอง (HMAC-SHA256 คีย์ทดสอบ) · ชื่อผู้ยื่นแสดงแบบปิดบังเพื่อคุ้มครองข้อมูลส่วนบุคคล</p>
</section>`;
}

// ───────────────────────── PDF (ASCII ล้วน · ไม่บีบอัด) ─────────────────────────

function pdfEsc(s) {
  return String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
}

/**
 * PDF 1 หน้า (Helvetica) · มีบรรทัดที่เครื่องอ่านได้บรรทัดเดียว:
 *   docNo=<เลข> caseNo=<เลข> verify=<รหัส> validUntil=<YYYY-MM-DD>
 * ข้อความไทยตรวจผ่าน /verify (A-63) · ไม่ใส่ชื่อ/เลขบัตร/เบอร์ลงไฟล์
 */
function renderPdf(row) {
  const docNo = row.doc_no;
  const caseNo = row.case_no;
  const verifyUrl = `${BASE_URL}/verify/${row.verify_code}`;
  const machine = `docNo=${docNo} caseNo=${caseNo} verify=${row.verify_code} validUntil=${row.valid_until}`;
  const lines = [
    [16, 'Suk Jai City Municipality (fictitious) - Digital Document'],
    [10, 'Simulated e-Service for testing only. Not a real government document.'],
    [11, ''],
    [11, `Document No: ${docNo}`],
    [11, `Case No: ${caseNo}`],
    [11, `Service: ${row.service_id}`],
    [11, `Issued: ${row.issued_at}`],
    [11, `Valid until: ${row.valid_until} (last valid day, Asia/Bangkok)`],
    [11, `Verify code: ${row.verify_code}`],
    [11, `Verify at: ${verifyUrl}`],
    [11, `Signature (HMAC-SHA256, test key): ${row.signature}`],
    [11, ''],
    [10, machine],
  ];
  let y = 800;
  const ops = ['BT'];
  for (const [size, text] of lines) {
    ops.push(`/F1 ${size} Tf 1 0 0 1 50 ${y} Tm (${pdfEsc(text)}) Tj`);
    y -= size + 10;
  }
  ops.push('ET');
  const content = `${ops.join('\n')}\n`;

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    `<< /Title (${pdfEsc(docNo)}) /Producer (egov-eservice simulated) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ───────────────────────── routes ─────────────────────────

function register(app, ctx = {}) {
  const db = ctx.db || dbm.db;
  const TEST_MODE = ctx.TEST_MODE !== undefined ? !!ctx.TEST_MODE : process.env.TEST_MODE === '1';
  const r = express.Router();

  const sendVerifyPage = (req, res, v) => auth.sendPage(req, res, {
    status: v.result === 'NOT_FOUND' ? 404 : 200,
    title: `ตรวจเอกสาร · ${RESULT_TH[v.result]}`,
    body: verifyPageBody(v),
  });

  // ฟอร์มกรอกรหัส · ?code=XXXX → /verify/XXXX
  r.get('/verify', (req, res) => {
    const q = normCode(req.query.code);
    if (q) return res.redirect(302, `/verify/${encodeURIComponent(q)}`);
    return auth.sendPage(req, res, {
      title: 'ตรวจเอกสาร',
      body: html`<style>${raw(PAGE_STYLE)}</style><h1>ตรวจสอบเอกสารดิจิทัล</h1>
<p>กรอกรหัสตรวจสอบ 8 ตัวที่พิมพ์บนเอกสาร หรือสแกน QR บนเอกสาร</p>${verifyForm()}`,
    });
  });

  r.get('/verify/:code', (req, res) => sendVerifyPage(req, res, verifyDocument(req.params.code, clock.now(), db)));

  r.get('/api/verify/:code', (req, res) => {
    const v = verifyDocument(req.params.code, clock.now(), db);
    return res.status(v.result === 'NOT_FOUND' ? 404 : 200).json(verifyJson(v));
  });

  // ดาวน์โหลด PDF · citizen: เฉพาะของตัวเอง (ของคนอื่น = 404 เหมือนไม่มี) · officer/head: ได้ · บทบาทอื่น 403
  r.get('/api/documents/:docNo/pdf', auth.requireApi('citizen', 'officer', 'head'), (req, res) => {
    const docNo = String(req.params.docNo || '');
    const notFound = () => auth.apiError(res, 404, 'NOT_FOUND', RESULT_TH.NOT_FOUND);
    if (!DOC_NO_RE.test(docNo)) return notFound();
    const row = db.prepare(`SELECT d.*, c.user_id AS case_user_id FROM documents d
      JOIN cases c ON c.case_no = d.case_no WHERE d.doc_no = ?`).get(docNo);
    if (!row) return notFound();
    if (req.user.role === 'citizen' && row.case_user_id !== req.user.id) return notFound();
    const pdf = renderPdf(row);
    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${docNo}.pdf"`);
    res.set('Content-Length', String(pdf.length));
    return res.end(pdf);
  });

  // test hook: แก้ข้อมูลที่เก็บ (ชื่อผู้ยื่นใน payload ที่ลงนาม) โดยไม่คำนวณลายเซ็นใหม่ (CONTRACT §3 §8)
  r.post('/api/test/documents/:docNo/tamper', (req, res) => {
    if (!TEST_MODE) return res.status(404).json({ code: 'NOT_FOUND', message: 'ไม่พบ' });
    const docNo = String(req.params.docNo || '');
    const row = db.prepare('SELECT doc_no, payload FROM documents WHERE doc_no = ?').get(docNo);
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: RESULT_TH.NOT_FOUND });
    const p = parsePayload(row) || {};
    p.applicant = `${p.applicant || ''} (แก้ไข)`;
    db.prepare('UPDATE documents SET payload = ? WHERE doc_no = ?').run(JSON.stringify(p), docNo);
    return res.status(200).json({ ok: true });
  });

  app.use(r);
}

module.exports = register;
Object.assign(module.exports, {
  register,
  createDocument,
  verifyDocument,
  verifyJson,
  validUntilFor,
  isExpired,
  maskApplicant,
  renderPdf,
  RESULT_TH,
});
