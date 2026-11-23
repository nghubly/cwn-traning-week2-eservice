'use strict';
/**
 * Seed ข้อมูลทดสอบ (บล็อก B02) · ตรงตาม /workspace/egov-brief/TEST-DATA.md ทุกค่า
 * เรียกโดย lib/reset.js หลัง DROP ทุกตาราง + ล้าง UPLOAD_DIR + ตั้งนาฬิกา 2026-12-01T09:00:00+07:00
 *
 *   seed(ctx)  ctx = {db, clock, pii, password, nextSeq, setSeq, UPLOAD_DIR}  (synchronous)
 *
 * ข้อตกลงของข้อมูล (บล็อกอื่นอ่านแบบนี้):
 *  - เวลาทุกช่อง = ISO "+07:00" (ไม่มี epoch ms) · กำหนดเสร็จ (due_at) เก็บตายตัวตามตาราง 4.1 (A-35)
 *  - ประชาชน: username = NULL · ค้นด้วย id_no_hash = pii.lookupHash(เลขบัตร) · เลขบัตร/เบอร์เข้ารหัส
 *  - cases.dept = แผนกที่ถือเรื่องตอนนี้: registry | works | head (PENDING_APPROVAL) | NULL (ปิด/ยกเลิก)
 *    APPROVED (รอออกเอกสาร) → dept 'registry' · owner NULL · issuer = ผู้ออกเอกสาร
 *    PENDING_APPROVAL → dept 'head' · owner NULL (หัวหน้าฝ่ายมีคนเดียว)
 *    NEED_FIX → dept 'registry' · owner = ผู้ตีกลับ (ส่งแก้แล้วคืนผู้ถือเดิม)
 *  - คำขอ seed ไม่มี draft_id และไม่มี payment_ref (ชำระจากระบบเดิม) · ใบเสร็จ RC ลำดับเดียวกับเลขคำขอ
 *  - ไฟล์แนบ = PDF จริง 1,024 ไบต์ เขียนลง UPLOAD_DIR/<storage_name> · files.id = "seed-<ลำดับ>-<docKey>"
 *  - เอกสาร DOC-2569-000001: ลายเซ็น = docSignature(payload) (ดูด้านล่าง · บล็อก B09 ใช้สูตรเดียวกัน)
 *  - audit_log / notifications / sessions / otp_attempts ว่าง
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOC_HMAC_KEY = process.env.DOC_HMAC_KEY || 'egov-test-doc-hmac-key-not-for-production';

/** ลำดับฟิลด์ที่ลงนาม (CONTRACT §3) · คั่นด้วย '|' · HMAC-SHA256 ด้วยคีย์ DOC_HMAC_KEY (สตริงตรง ๆ) → base64url */
const SIGN_FIELDS = ['docNo', 'caseNo', 'applicant', 'serviceId', 'issuedAt', 'validUntil', 'signer'];
function docSignature(p) {
  const msg = SIGN_FIELDS.map((k) => (p[k] === null || p[k] === undefined ? '' : String(p[k]))).join('|');
  return crypto.createHmac('sha256', DOC_HMAC_KEY).update(msg, 'utf8').digest('base64url');
}

/** PDF จริงขนาด n ไบต์ (สูตรเดียวกับ make_testfiles.py ใน TEST-DATA §11) */
function pdfBytes(n = 1024) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  return Buffer.concat([head, Buffer.alloc(n - head.length - tail.length, 0x20), tail]);
}

// ---------------------------------------------------------------------------------------------
// ข้อมูลคงที่
// ---------------------------------------------------------------------------------------------

const T = (s) => `${s.replace(' ', 'T')}:00+07:00`; // '2026-11-20 10:00' → ISO +07:00

const ACCOUNT_CREATED = '2026-10-01T08:00:00+07:00';

const CITIZENS = [
  { key: 'somchai', name: 'สมชาย ใจดี', idNo: '1101700123456', mobile: '0812345678', registered: 1 },
  { key: 'somying', name: 'สมหญิง รักไทย', idNo: '3100600987659', mobile: '0823456789', registered: 1 },
  { key: 'mana', name: 'มานะ ตั้งใจ', idNo: '5500400111221', mobile: null, registered: 0 },
  { key: 'piti', name: 'ปิติ มีสุข', idNo: '1909900555015', mobile: '0834567890', registered: 1 },
];

const STAFF = [
  { username: 'off.reg1', name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry' },
  { username: 'off.reg2', name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry' },
  { username: 'off.works1', name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works' },
  { username: 'head1', name: 'หัวหน้าฝ่าย', role: 'head', dept: '' },
  { username: 'exec1', name: 'ผู้บริหาร', role: 'executive', dept: '' },
  { username: 'audit1', name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: '' },
  { username: 'admin1', name: 'ผู้ดูแลระบบ', role: 'admin', dept: '' },
];
const STAFF_PASSWORD = 'Test@1234';

const SERVICES = [
  { id: 'SV-01', name: 'ขอหนังสือรับรอง', fee: 20, fee_base: null, fee_per_sqm: null, sla: 3, sort: 1 },
  { id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ', fee: 500, fee_base: null, fee_per_sqm: null, sla: 10, sort: 2 },
  { id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', fee: null, fee_base: 1000, fee_per_sqm: 10, sla: 15, sort: 3 },
];

// [service, doc_key, label, required, pdf_only] · ลำดับ = ลำดับใน missing-docs (CONTRACT 4.3)
const SERVICE_DOCS = [
  ['SV-01', 'id-card', 'บัตรประชาชน', 1, 0],
  ['SV-02', 'id-card', 'บัตรประชาชน', 1, 0],
  ['SV-02', 'map', 'แผนที่ตั้ง', 1, 0],
  ['SV-02', 'site-photo', 'ภาพสถานที่', 0, 0],
  ['SV-03', 'id-card', 'บัตรประชาชน', 1, 0],
  ['SV-03', 'plan', 'แบบแปลน', 1, 1],
  ['SV-03', 'deed', 'โฉนด', 1, 0],
];
const REQUIRED_DOCS = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['id-card', 'plan', 'deed'] };

const HOLIDAYS = [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'],
  ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'],
  ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
];

/**
 * คำขอ 30 ใบ (TEST-DATA 4.1) · flow = ลำดับเหตุการณ์หลังชำระ (SUBMIT ใส่ให้อัตโนมัติที่ paid)
 *   ['CLAIM', time, user]                 รับเรื่อง (SUBMITTED→IN_REVIEW หรือ IN_REVIEW→IN_REVIEW ที่ขั้นโยธา)
 *   ['FORWARD', time, user, to]           ส่งต่อ (ขั้นถัดไป)
 *   ['RETURN', time, user, reason]        ตีกลับ  ·  ['RESUBMIT', time]  ประชาชนส่งแก้
 *   ['APPROVE', time, user] · ['REJECT', time, user, reason] · ['ISSUE', time, user] · ['CANCEL', time]
 */
const CASES = [
  { seq: 1, label: 'H01', svc: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'COMPLETED', paid: '2026-10-14 10:00', due: '2026-10-19 16:30',
    flow: [['CLAIM', '2026-10-14 10:30', 'off.reg1'], ['APPROVE', '2026-10-16 13:30', 'off.reg1'], ['ISSUE', '2026-10-16 14:00', 'off.reg1']] },
  { seq: 2, label: 'H05', svc: 'SV-03', area: 120, fee: 1200, who: 'piti', status: 'COMPLETED', paid: '2026-11-02 09:00', due: '2026-11-23 16:30',
    flow: [['CLAIM', '2026-11-02 09:30', 'off.reg1'], ['FORWARD', '2026-11-04 10:00', 'off.reg1', 'works'], ['CLAIM', '2026-11-04 11:00', 'off.works1'],
      ['FORWARD', '2026-11-11 10:00', 'off.works1', 'head'], ['APPROVE', '2026-11-19 10:00', 'head1'], ['ISSUE', '2026-11-20 11:00', 'off.reg1']] },
  { seq: 3, label: 'H02', svc: 'SV-01', qty: 2, fee: 40, who: 'piti', status: 'COMPLETED', paid: '2026-11-02 09:30', due: '2026-11-05 16:30',
    flow: [['CLAIM', '2026-11-02 10:00', 'off.reg2'], ['APPROVE', '2026-11-04 14:30', 'off.reg2'], ['ISSUE', '2026-11-04 15:00', 'off.reg2']] },
  { seq: 4, label: 'H06', svc: 'SV-02', fee: 500, who: 'somchai', status: 'COMPLETED', paid: '2026-11-02 14:00', due: '2026-11-16 16:30',
    flow: [['CLAIM', '2026-11-02 14:30', 'off.reg1'], ['FORWARD', '2026-11-05 10:00', 'off.reg1', 'head'], ['APPROVE', '2026-11-12 10:00', 'head1'],
      ['ISSUE', '2026-11-13 15:00', 'off.reg1']] },
  { seq: 5, label: 'H03', svc: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'COMPLETED', paid: '2026-11-03 11:00', due: '2026-11-06 16:30',
    flow: [['CLAIM', '2026-11-03 11:30', 'off.reg1'], ['APPROVE', '2026-11-05 09:30', 'off.reg1'], ['ISSUE', '2026-11-05 10:00', 'off.reg1']],
    doc: { docNo: 'DOC-2569-000001', verifyCode: 'K7M2Q9XA', validUntil: '2027-02-02' } },
  { seq: 6, label: 'H08', svc: 'SV-02', fee: 500, who: 'piti', status: 'COMPLETED', paid: '2026-11-03 15:00', due: '2026-11-17 16:30',
    flow: [['CLAIM', '2026-11-03 15:30', 'off.reg2'], ['FORWARD', '2026-11-10 10:00', 'off.reg2', 'head'], ['APPROVE', '2026-11-18 14:00', 'head1'],
      ['ISSUE', '2026-11-19 10:00', 'off.reg2']] },
  { seq: 7, label: 'H07', svc: 'SV-02', fee: 500, who: 'somying', status: 'COMPLETED', paid: '2026-11-04 10:00', due: '2026-11-18 16:30',
    flow: [['CLAIM', '2026-11-04 10:30', 'off.reg1'], ['FORWARD', '2026-11-09 10:00', 'off.reg1', 'head'], ['APPROVE', '2026-11-17 10:00', 'head1'],
      ['ISSUE', '2026-11-18 16:00', 'off.reg1']] },
  { seq: 8, label: 'H04', svc: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'REJECTED', paid: '2026-11-09 10:00', due: '2026-11-12 16:30',
    flow: [['CLAIM', '2026-11-09 10:30', 'off.reg1'], ['REJECT', '2026-11-11 09:00', 'off.reg1', 'ผู้ยื่นไม่มีชื่อในทะเบียนของเทศบาล จึงออกหนังสือรับรองไม่ได้']] },
  { seq: 9, label: 'X01', svc: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'CANCELLED', paid: '2026-11-09 14:30', due: '2026-11-12 16:30',
    flow: [['CANCEL', '2026-11-09 15:00']] },
  { seq: 10, label: 'W01', svc: 'SV-03', area: 80, fee: 1000, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-12 10:00', due: '2026-12-03 16:30',
    flow: [['CLAIM', '2026-11-12 10:30', 'off.reg1'], ['FORWARD', '2026-11-13 10:00', 'off.reg1', 'works']] },
  { seq: 11, label: 'P02', svc: 'SV-03', area: 150, fee: 1500, who: 'somchai', status: 'PENDING_APPROVAL', paid: '2026-11-16 10:00', due: '2026-12-08 16:30',
    flow: [['CLAIM', '2026-11-16 10:30', 'off.reg1'], ['FORWARD', '2026-11-17 10:00', 'off.reg1', 'works'], ['CLAIM', '2026-11-17 11:00', 'off.works1'],
      ['FORWARD', '2026-11-20 10:00', 'off.works1', 'head']] },
  { seq: 12, label: 'R09', svc: 'SV-03', area: 101, fee: 1010, who: 'piti', status: 'IN_REVIEW', paid: '2026-11-18 10:00', due: '2026-12-11 16:30',
    flow: [['CLAIM', '2026-11-18 10:30', 'off.reg2']] },
  { seq: 13, label: 'R01', svc: 'SV-02', fee: 500, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-20 10:00', due: '2026-12-04 16:30',
    flow: [['CLAIM', '2026-11-20 10:30', 'off.reg2']] },
  { seq: 14, label: 'P01', svc: 'SV-02', fee: 500, who: 'piti', status: 'PENDING_APPROVAL', paid: '2026-11-20 11:00', due: '2026-12-04 16:30',
    flow: [['CLAIM', '2026-11-20 11:30', 'off.reg1'], ['FORWARD', '2026-11-23 10:00', 'off.reg1', 'head']] },
  { seq: 15, label: 'R02', svc: 'SV-02', fee: 500, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-20 15:00', due: '2026-12-04 16:30',
    flow: [['CLAIM', '2026-11-20 15:30', 'off.reg2']] },
  { seq: 16, label: 'R03', svc: 'SV-02', fee: 500, who: 'piti', status: 'IN_REVIEW', paid: '2026-11-23 09:00', due: '2026-12-08 16:30',
    flow: [['CLAIM', '2026-11-23 09:30', 'off.reg2']] },
  { seq: 17, label: 'F01', svc: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'NEED_FIX', paid: '2026-11-23 10:00', due: '2026-11-27 16:30',
    flow: [['CLAIM', '2026-11-23 10:30', 'off.reg1'],
      ['RETURN', '2026-11-24 11:00', 'off.reg1', 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่'], ['RESUBMIT', '2026-11-25 10:00', 1],
      ['RETURN', '2026-11-27 14:00', 'off.reg1', 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข']] },
  { seq: 18, label: 'R04', svc: 'SV-02', fee: 500, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-24 10:00', due: '2026-12-09 16:30',
    flow: [['CLAIM', '2026-11-24 10:30', 'off.reg2']] },
  { seq: 19, label: 'A01', svc: 'SV-02', fee: 500, who: 'somying', status: 'APPROVED', paid: '2026-11-24 14:00', due: '2026-12-09 16:30',
    flow: [['CLAIM', '2026-11-24 14:30', 'off.reg1'], ['FORWARD', '2026-11-26 10:00', 'off.reg1', 'head'], ['APPROVE', '2026-11-30 15:00', 'head1']] },
  { seq: 20, label: 'O01', svc: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-25 10:00', due: '2026-11-30 16:30',
    flow: [['CLAIM', '2026-11-25 10:30', 'off.reg1']] },
  { seq: 21, label: 'R08', svc: 'SV-02', fee: 500, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-25 12:00', due: '2026-12-11 16:30',
    flow: [['CLAIM', '2026-11-25 12:30', 'off.reg2']] },
  { seq: 22, label: 'N02', svc: 'SV-01', qty: 2, fee: 40, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-26 10:00', due: '2026-12-01 16:30',
    flow: [['CLAIM', '2026-11-26 10:30', 'off.reg1']] },
  { seq: 23, label: 'F02', svc: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-26 10:30', due: '2026-12-03 16:30',
    flow: [['CLAIM', '2026-11-26 11:00', 'off.reg1'],
      ['RETURN', '2026-11-27 10:00', 'off.reg1', 'ภาพเอกสารเบลอ อ่านเลขไม่ได้'], ['RESUBMIT', '2026-11-30 10:00', 1],
      ['RETURN', '2026-11-30 14:00', 'off.reg1', 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน'], ['RESUBMIT', '2026-12-01 08:30', 1]] },
  { seq: 24, label: 'N01', svc: 'SV-01', qty: 1, fee: 20, who: 'piti', status: 'SUBMITTED', paid: '2026-11-27 11:00', due: '2026-12-02 16:30', flow: [] },
  { seq: 25, label: 'R05', svc: 'SV-01', qty: 3, fee: 60, who: 'somying', status: 'IN_REVIEW', paid: '2026-11-30 10:00', due: '2026-12-03 16:30',
    flow: [['CLAIM', '2026-11-30 10:30', 'off.reg2']] },
  { seq: 26, label: 'R07', svc: 'SV-01', qty: 5, fee: 100, who: 'somchai', status: 'IN_REVIEW', paid: '2026-11-30 16:29', due: '2026-12-03 16:30',
    flow: [['CLAIM', '2026-11-30 16:40', 'off.reg2']] },
  { seq: 27, label: 'R06', svc: 'SV-01', qty: 1, fee: 20, who: 'piti', status: 'IN_REVIEW', paid: '2026-11-30 16:30', due: '2026-12-04 16:30',
    flow: [['CLAIM', '2026-11-30 16:45', 'off.reg2']] },
  { seq: 28, label: 'S01', svc: 'SV-01', qty: 1, fee: 20, who: 'somying', status: 'SUBMITTED', paid: '2026-12-01 08:10', due: '2026-12-04 16:30', flow: [] },
  { seq: 29, label: 'S02', svc: 'SV-01', qty: 1, fee: 20, who: 'piti', status: 'SUBMITTED', paid: '2026-12-01 08:20', due: '2026-12-04 16:30', flow: [] },
  { seq: 30, label: 'S03', svc: 'SV-01', qty: 1, fee: 20, who: 'somchai', status: 'SUBMITTED', paid: '2026-12-01 08:30', due: '2026-12-04 16:30', flow: [] },
];

const DRAFTS = [
  { id: 'DR-0001', who: 'somchai', svc: 'SV-01', status: 'DRAFT', qty: 2, fee: 40, created: '2026-11-30 19:00', files: [] },
  { id: 'DR-0002', who: 'somchai', svc: 'SV-02', status: 'PENDING_PAYMENT', fee: 500, feeLocked: 500, lockedAt: '2026-12-01 08:55',
    created: '2026-12-01 08:40', files: ['id-card', 'map'] },
];

const PAYMENTS = [
  { ref: 'PP-0001', draft: 'DR-0002', amount: 500, status: 'PENDING', created: '2026-12-01T08:55:00+07:00', expires: '2026-12-01T09:10:00+07:00' },
];

// ---------------------------------------------------------------------------------------------

function seed(ctx) {
  const { db, pii, password, setSeq, UPLOAD_DIR } = ctx;
  const pwHash = password.hashPassword(STAFF_PASSWORD); // scrypt ครั้งเดียวแล้วใช้ซ้ำ
  const pdf = pdfBytes(1024);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const ins = {
    user: db.prepare(`INSERT INTO users (username, password_hash, name, role, dept, id_no_enc, id_no_hash, id_masked, mobile_enc, email_enc,
      registered, consent_at, active, created_at, updated_at) VALUES (@username, @password_hash, @name, @role, @dept, @id_no_enc, @id_no_hash,
      @id_masked, @mobile_enc, NULL, @registered, @consent_at, 1, @created_at, @created_at)`),
    service: db.prepare(`INSERT INTO services (id, name, fee, fee_base, fee_per_sqm, sla, sort, updated_at)
      VALUES (@id, @name, @fee, @fee_base, @fee_per_sqm, @sla, @sort, @updated_at)`),
    sdoc: db.prepare('INSERT INTO service_docs (service_id, doc_key, label, required, pdf_only, sort) VALUES (?, ?, ?, ?, ?, ?)'),
    holiday: db.prepare('INSERT INTO holidays (date, name, created_at) VALUES (?, ?, ?)'),
    draft: db.prepare(`INSERT INTO drafts (id, user_id, service_id, status, qty, area_sqm, fee, fee_locked, locked_at, case_no, created_at, updated_at)
      VALUES (@id, @user_id, @service_id, @status, @qty, @area_sqm, @fee, @fee_locked, @locked_at, NULL, @created_at, @updated_at)`),
    case: db.prepare(`INSERT INTO cases (case_no, year_be, seq, draft_id, user_id, service_id, qty, area_sqm, fee, status, dept, step, owner, issuer,
      registry_officer, works_officer, return_count, paid_at, due_at, need_fix_at, fix_deadline, approved_by, approved_at, closed_at, cancelled_at,
      cancel_reason, receipt_no, payment_ref, created_at, updated_at) VALUES (@case_no, @year_be, @seq, NULL, @user_id, @service_id, @qty, @area_sqm,
      @fee, @status, @dept, @step, @owner, @issuer, @registry_officer, @works_officer, @return_count, @paid_at, @due_at, @need_fix_at, @fix_deadline,
      @approved_by, @approved_at, @closed_at, @cancelled_at, @cancel_reason, @receipt_no, NULL, @created_at, @updated_at)`),
    ret: db.prepare(`INSERT INTO case_returns (case_no, n, returned_at, returned_by, reason, resubmitted_at, paused_days)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    event: db.prepare(`INSERT INTO case_events (case_no, time, actor, event, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    file: db.prepare(`INSERT INTO files (id, draft_id, case_no, doc_key, name, mime, size, storage_name, uploaded_by, is_seed, created_at)
      VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?, 1, ?)`),
    payment: db.prepare(`INSERT INTO payments (ref, draft_id, amount, status, qr_created_at, qr_expires_at, paid_at, case_no, receipt_no)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`),
    receipt: db.prepare('INSERT INTO receipts (receipt_no, case_no, payment_ref, amount, issued_at) VALUES (?, ?, NULL, ?, ?)'),
    document: db.prepare(`INSERT INTO documents (doc_no, case_no, verify_code, service_id, applicant_masked, issued_at, valid_until, signer,
      signer_username, payload, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  };

  const writeFile = (id, docKey, { caseNo = null, draftId = null, userId, at }) => {
    const storage = `${id}.pdf`;
    fs.writeFileSync(path.join(UPLOAD_DIR, storage), pdf);
    ins.file.run(id, draftId, caseNo, docKey, `${docKey}.pdf`, pdf.length, storage, userId, at);
  };

  db.transaction(() => {
    // 1) บัญชี
    const uid = {};
    const staffName = {};
    for (const c of CITIZENS) {
      const r = ins.user.run({
        username: null, password_hash: null, name: c.name, role: 'citizen', dept: '',
        id_no_enc: pii.encrypt(c.idNo), id_no_hash: pii.lookupHash(c.idNo), id_masked: pii.maskIdNo(c.idNo),
        mobile_enc: c.mobile ? pii.encrypt(c.mobile) : null,
        registered: c.registered, consent_at: c.registered ? ACCOUNT_CREATED : null, created_at: ACCOUNT_CREATED,
      });
      uid[c.key] = Number(r.lastInsertRowid);
    }
    for (const s of STAFF) {
      const r = ins.user.run({
        username: s.username, password_hash: pwHash, name: s.name, role: s.role, dept: s.dept,
        id_no_enc: null, id_no_hash: null, id_masked: null, mobile_enc: null, registered: 1, consent_at: null, created_at: ACCOUNT_CREATED,
      });
      uid[s.username] = Number(r.lastInsertRowid);
      staffName[s.username] = s.name;
    }

    // 2) บริการ + เอกสารที่ต้องใช้ + วันหยุด
    for (const s of SERVICES) ins.service.run({ ...s, updated_at: ACCOUNT_CREATED });
    SERVICE_DOCS.forEach(([svc, key, label, req, pdfOnly], i) => ins.sdoc.run(svc, key, label, req, pdfOnly, i + 1));
    for (const [date, name] of HOLIDAYS) ins.holiday.run(date, name, ACCOUNT_CREATED);

    // 3) คำขอ 30 ใบ
    for (const c of CASES) {
      const caseNo = `EG-2569-${String(c.seq).padStart(6, '0')}`;
      const receiptNo = `RC-2569-${String(c.seq).padStart(6, '0')}`;
      const paidAt = T(c.paid);
      const row = {
        case_no: caseNo, year_be: 2569, seq: c.seq, user_id: uid[c.who], service_id: c.svc,
        qty: c.svc === 'SV-01' ? c.qty : null, area_sqm: c.svc === 'SV-03' ? c.area : null, fee: c.fee,
        status: c.status, dept: 'registry', step: c.svc === 'SV-03' ? 1 : null, owner: null, issuer: null,
        registry_officer: null, works_officer: null, return_count: 0, paid_at: paidAt, due_at: T(c.due),
        need_fix_at: null, fix_deadline: null, approved_by: null, approved_at: null, closed_at: null,
        cancelled_at: null, cancel_reason: null, receipt_no: receiptNo, created_at: paidAt, updated_at: paidAt,
      };
      const events = [[paidAt, 'citizen', 'SUBMIT', null, 'SUBMITTED', `ชำระเงินแล้ว ใบเสร็จ ${receiptNo}`]];
      const returns = [];
      let st = 'SUBMITTED';
      const move = (time, actor, event, to, note = null) => { events.push([time, actor, event, st, to, note]); st = to; row.updated_at = time; };

      for (const [ev, at, a, b] of c.flow) {
        const time = T(at);
        switch (ev) {
          case 'CLAIM':
            row.owner = a;
            if (row.dept === 'registry') { if (!row.registry_officer) row.registry_officer = a; if (!row.issuer) row.issuer = a; }
            if (row.dept === 'works') row.works_officer = a;
            move(time, a, 'CLAIM', 'IN_REVIEW');
            break;
          case 'FORWARD':
            row.owner = null;
            row.dept = b;
            if (b === 'works') { row.step = 2; move(time, a, 'FORWARD', 'IN_REVIEW', 'ส่งต่อฝ่ายโยธา (ขั้นตอน 2/3)'); }
            else { if (c.svc === 'SV-03') row.step = 3; move(time, a, 'FORWARD', 'PENDING_APPROVAL', 'ส่งต่อหัวหน้าฝ่ายอนุมัติ'); }
            break;
          case 'RETURN':
            row.return_count += 1;
            row.need_fix_at = time;
            row.fix_deadline = clockAdd(time, 168 * 3600 * 1000, ctx.clock);
            returns.push({ n: row.return_count, at: time, by: a, reason: b, resub: null, paused: null });
            move(time, a, 'RETURN', 'NEED_FIX', b);
            break;
          case 'RESUBMIT':
            returns[returns.length - 1].resub = time;
            returns[returns.length - 1].paused = a;
            row.fix_deadline = null;
            move(time, 'citizen', 'RESUBMIT', 'IN_REVIEW', 'ส่งเอกสารแก้ไขแล้ว');
            break;
          case 'APPROVE':
            row.approved_by = a;
            row.approved_at = time;
            row.owner = null;
            row.dept = 'registry';
            move(time, a, 'APPROVE', 'APPROVED');
            break;
          case 'REJECT':
            row.closed_at = time;
            row.dept = null;
            move(time, a, 'REJECT', 'REJECTED', b);
            break;
          case 'ISSUE':
            row.closed_at = time;
            row.dept = null;
            row.owner = row.issuer;
            move(time, a, 'ISSUE', 'COMPLETED', c.doc ? c.doc.docNo : 'ออกเอกสารจากระบบเดิม');
            break;
          case 'CANCEL':
            row.cancelled_at = time;
            row.cancel_reason = 'citizen';
            row.dept = null;
            move(time, 'citizen', 'CANCEL', 'CANCELLED', 'ประชาชนยกเลิกคำขอเอง');
            break;
          default:
            throw new Error(`seed: unknown flow event ${ev}`);
        }
      }
      if (st !== c.status) throw new Error(`seed: ${caseNo} flow ends at ${st} but table says ${c.status}`);
      if (c.status === 'NEED_FIX') row.dept = 'registry';

      ins.case.run(row);
      for (const e of events) ins.event.run(caseNo, ...e);
      for (const r of returns) ins.ret.run(caseNo, r.n, r.at, r.by, r.reason, r.resub, r.paused);
      ins.receipt.run(receiptNo, caseNo, c.fee, paidAt);

      const upAt = ctx.clock.toIso(ctx.clock.addMs(paidAt, -10 * 60 * 1000));
      for (const key of REQUIRED_DOCS[c.svc]) {
        writeFile(`seed-${String(c.seq).padStart(6, '0')}-${key}`, key, { caseNo, userId: uid[c.who], at: upAt });
      }

      if (c.doc) {
        const applicant = CITIZENS.find((x) => x.key === c.who).name;
        const issue = c.flow.find((f) => f[0] === 'ISSUE');
        const signerUser = row.approved_by;
        const payload = {
          docNo: c.doc.docNo, caseNo, applicant, serviceId: c.svc,
          issuedAt: T(issue[1]), validUntil: c.doc.validUntil, signer: staffName[signerUser],
        };
        ins.document.run(c.doc.docNo, caseNo, c.doc.verifyCode, c.svc, pii.maskName(applicant), payload.issuedAt, payload.validUntil,
          payload.signer, signerUser, JSON.stringify(payload), docSignature(payload));
      }
    }

    // 4) ร่าง + รอชำระของสมชาย
    for (const d of DRAFTS) {
      ins.draft.run({
        id: d.id, user_id: uid[d.who], service_id: d.svc, status: d.status, qty: d.qty ?? null, area_sqm: d.area ?? null,
        fee: d.fee, fee_locked: d.feeLocked ?? null, locked_at: d.lockedAt ? T(d.lockedAt) : null,
        created_at: T(d.created), updated_at: d.lockedAt ? T(d.lockedAt) : T(d.created),
      });
      for (const key of d.files) writeFile(`seed-${d.id}-${key}`, key, { draftId: d.id, userId: uid[d.who], at: T(d.created) });
    }
    for (const p of PAYMENTS) ins.payment.run(p.ref, p.draft, p.amount, p.status, p.created, p.expires);

    // 5) เลขรันถัดไป: EG/RC-2569-000031 · DOC-2569-000002 · DR-0003 · PP-0002
    setSeq('case:2569', 30);
    setSeq('receipt:2569', 30);
    setSeq('doc:2569', 1);
    setSeq('draft', 2);
    setSeq('payment', 1);
  })();
}

function clockAdd(iso, ms, clock) {
  return clock.toIso(clock.addMs(iso, ms));
}

module.exports = { seed, docSignature, SIGN_FIELDS, DOC_HMAC_KEY, pdfBytes, CASES, CITIZENS, STAFF };
