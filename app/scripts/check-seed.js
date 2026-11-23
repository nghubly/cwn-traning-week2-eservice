#!/usr/bin/env node
'use strict';
/**
 * ตรวจ seed เทียบ TEST-DATA (ตาราง 1–6, 4.1/4.4, 7, 9, 10, 12) · ไม่ต้องเปิดเซิร์ฟเวอร์
 *
 *   node scripts/check-seed.js            → reset+seed ลงฐานข้อมูลชั่วคราว (ไม่แตะ ./data) แล้วตรวจ
 *   node scripts/check-seed.js --db data/egov.db [--uploads data/uploads]
 *                                         → ตรวจไฟล์ฐานข้อมูลที่มีอยู่แบบอ่านอย่างเดียว (ควรเป็นสภาพหลัง reset ทันที)
 *
 * ค่าที่คาดหวังเขียนซ้ำจาก TEST-DATA ตรง ๆ (ไม่ได้อ่านจาก server/seed.js) · ออกด้วยรหัส 1 ถ้ามีข้อใดไม่ผ่าน
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.join(__dirname, '..');

let db; let uploadDir; let pii; let resetNow = null; let tmp = null;
if (argOf('--db')) {
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const dbPath = path.resolve(argOf('--db'));
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  uploadDir = path.resolve(argOf('--uploads') || path.join(path.dirname(dbPath), 'uploads'));
  pii = require(path.join(ROOT, 'server', 'lib', 'pii'));
} else {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egov-check-seed-'));
  process.env.TEST_MODE = '1';
  process.env.DB_PATH = path.join(tmp, 'egov.db');
  process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
  const { resetAll } = require(path.join(ROOT, 'server', 'lib', 'reset'));
  resetNow = resetAll();
  db = require(path.join(ROOT, 'server', 'db')).db;
  uploadDir = process.env.UPLOAD_DIR;
  pii = require(path.join(ROOT, 'server', 'lib', 'pii'));
}

let pass = 0; const fails = [];
function eq(label, got, want) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g === w) pass += 1; else fails.push(`${label}\n    ได้  ${g}\n    ควร ${w}`);
}
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const count = (sql, ...p) => one(sql, ...p).n;
const T = (s) => (s ? `${s.replace(' ', 'T')}:00+07:00` : null);
const cn = (n) => `EG-2569-${String(n).padStart(6, '0')}`;
const NOW = '2026-12-01T09:00:00+07:00';
const NOW_MS = Date.parse(NOW);

// ---------- §10 นาฬิกา ----------
if (resetNow !== null) eq('§10 นาฬิกาหลัง reset', resetNow, NOW);

// ---------- §1 บัญชี ----------
const CIT = [
  ['สมชาย ใจดี', '1101700123456', 'X-XXXX-XXXXX-45-6', '0812345678', 1],
  ['สมหญิง รักไทย', '3100600987659', 'X-XXXX-XXXXX-65-9', '0823456789', 1],
  ['มานะ ตั้งใจ', '5500400111221', 'X-XXXX-XXXXX-22-1', null, 0],
  ['ปิติ มีสุข', '1909900555015', 'X-XXXX-XXXXX-01-5', '0834567890', 1],
];
eq('§1.1 จำนวนประชาชน', count("SELECT COUNT(*) n FROM users WHERE role='citizen'"), 4);
const uidByName = {};
for (const [name, idNo, masked, mobile, reg] of CIT) {
  const u = one('SELECT * FROM users WHERE id_no_hash = ?', pii.lookupHash(idNo));
  if (!u) { fails.push(`§1.1 ไม่พบผู้ใช้ ${name} จาก lookupHash`); continue; }
  uidByName[name] = u.id;
  eq(`§1.1 ${name} ชื่อ/บทบาท/ลงทะเบียน`, [u.name, u.role, u.registered], [name, 'citizen', reg]);
  eq(`§1.1 ${name} เลขปิดบัง`, u.id_masked, masked);
  eq(`§1.1 ${name} ถอดรหัสเลขบัตร`, pii.decrypt(u.id_no_enc), idNo);
  eq(`§1.1 ${name} ถอดรหัสเบอร์`, pii.decrypt(u.mobile_enc), mobile);
  eq(`§1.1 ${name} อีเมลว่าง`, u.email_enc, null);
  eq(`§1.1 ${name} เลขเต็มที่แสดง`, pii.formatIdNo(idNo), `${idNo[0]}-${idNo.slice(1, 5)}-${idNo.slice(5, 10)}-${idNo.slice(10, 12)}-${idNo[12]}`);
}
eq('§1.1 เลข checksum ผิดไม่มีในระบบ', one('SELECT id FROM users WHERE id_no_hash = ?', pii.lookupHash('1101700123457')) || null, null);
const STAFF = [
  ['off.reg1', 'เจ้าหน้าที่ทะเบียน 1', 'officer', 'registry'], ['off.reg2', 'เจ้าหน้าที่ทะเบียน 2', 'officer', 'registry'],
  ['off.works1', 'เจ้าหน้าที่โยธา 1', 'officer', 'works'], ['head1', 'หัวหน้าฝ่าย', 'head', ''], ['exec1', 'ผู้บริหาร', 'executive', ''],
  ['audit1', 'ผู้ตรวจสอบภายใน', 'auditor', ''], ['admin1', 'ผู้ดูแลระบบ', 'admin', ''],
];
eq('§1.2 จำนวนเจ้าหน้าที่/บทบาทอื่น', count("SELECT COUNT(*) n FROM users WHERE role<>'citizen'"), 7);
{
  const pw = require(path.join(ROOT, 'server', 'lib', 'password'));
  for (const [un, name, role, dept] of STAFF) {
    const u = one('SELECT * FROM users WHERE username = ?', un);
    if (!u) { fails.push(`§1.2 ไม่พบ ${un}`); continue; }
    eq(`§1.2 ${un}`, [u.name, u.role, u.dept, u.active], [name, role, dept, 1]);
    eq(`§1.2 ${un} รหัสผ่าน Test@1234`, pw.verifyPassword('Test@1234', u.password_hash), true);
  }
}

// ---------- §2 บริการ · §3 วันหยุด ----------
eq('§2 บริการ', all('SELECT id, name, fee, fee_base, fee_per_sqm, sla FROM services ORDER BY id').map(Object.values), [
  ['SV-01', 'ขอหนังสือรับรอง', 20, null, null, 3],
  ['SV-02', 'ขออนุญาตประกอบกิจการ', 500, null, null, 10],
  ['SV-03', 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', null, 1000, 10, 15],
]);
eq('§2 เอกสารของบริการ (ลำดับ missing-docs)', all('SELECT service_id, doc_key, label, required, pdf_only FROM service_docs ORDER BY service_id, sort').map(Object.values), [
  ['SV-01', 'id-card', 'บัตรประชาชน', 1, 0],
  ['SV-02', 'id-card', 'บัตรประชาชน', 1, 0], ['SV-02', 'map', 'แผนที่ตั้ง', 1, 0], ['SV-02', 'site-photo', 'ภาพสถานที่', 0, 0],
  ['SV-03', 'id-card', 'บัตรประชาชน', 1, 0], ['SV-03', 'plan', 'แบบแปลน', 1, 1], ['SV-03', 'deed', 'โฉนด', 1, 0],
]);
eq('§3 วันหยุด', all('SELECT date, name FROM holidays ORDER BY date').map(Object.values), [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'], ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'], ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
]);
const HOL = new Set(all('SELECT date FROM holidays').map((r) => r.date));

// ---------- §4.1 คำขอ 30 ใบ ----------
// [seq, ป้าย, บริการ, ฉบับ|ตร.ม., ค่าธรรมเนียม, ผู้ยื่น, สถานะ, owner, dept, step, ชำระ, กำหนด, ระดับ, ปิด(closed_at)]
const ROWS = [
  [1, 'H01', 'SV-01', 1, 20, 'สมหญิง รักไทย', 'COMPLETED', null, '2026-10-14 10:00', '2026-10-19 16:30', 'closed', '2026-10-16 14:00'],
  [2, 'H05', 'SV-03', 120, 1200, 'ปิติ มีสุข', 'COMPLETED', null, '2026-11-02 09:00', '2026-11-23 16:30', 'closed', '2026-11-20 11:00'],
  [3, 'H02', 'SV-01', 2, 40, 'ปิติ มีสุข', 'COMPLETED', null, '2026-11-02 09:30', '2026-11-05 16:30', 'closed', '2026-11-04 15:00'],
  [4, 'H06', 'SV-02', null, 500, 'สมชาย ใจดี', 'COMPLETED', null, '2026-11-02 14:00', '2026-11-16 16:30', 'closed', '2026-11-13 15:00'],
  [5, 'H03', 'SV-01', 1, 20, 'สมชาย ใจดี', 'COMPLETED', null, '2026-11-03 11:00', '2026-11-06 16:30', 'closed', '2026-11-05 10:00'],
  [6, 'H08', 'SV-02', null, 500, 'ปิติ มีสุข', 'COMPLETED', null, '2026-11-03 15:00', '2026-11-17 16:30', 'closed', '2026-11-19 10:00'],
  [7, 'H07', 'SV-02', null, 500, 'สมหญิง รักไทย', 'COMPLETED', null, '2026-11-04 10:00', '2026-11-18 16:30', 'closed', '2026-11-18 16:00'],
  [8, 'H04', 'SV-01', 1, 20, 'สมหญิง รักไทย', 'REJECTED', null, '2026-11-09 10:00', '2026-11-12 16:30', 'closed', '2026-11-11 09:00'],
  [9, 'X01', 'SV-01', 1, 20, 'สมชาย ใจดี', 'CANCELLED', null, '2026-11-09 14:30', '2026-11-12 16:30', 'closed', null],
  [10, 'W01', 'SV-03', 80, 1000, 'สมหญิง รักไทย', 'IN_REVIEW', null, '2026-11-12 10:00', '2026-12-03 16:30', 'normal', null],
  [11, 'P02', 'SV-03', 150, 1500, 'สมชาย ใจดี', 'PENDING_APPROVAL', null, '2026-11-16 10:00', '2026-12-08 16:30', 'normal', null],
  [12, 'R09', 'SV-03', 101, 1010, 'ปิติ มีสุข', 'IN_REVIEW', 'off.reg2', '2026-11-18 10:00', '2026-12-11 16:30', 'normal', null],
  [13, 'R01', 'SV-02', null, 500, 'สมชาย ใจดี', 'IN_REVIEW', 'off.reg2', '2026-11-20 10:00', '2026-12-04 16:30', 'normal', null],
  [14, 'P01', 'SV-02', null, 500, 'ปิติ มีสุข', 'PENDING_APPROVAL', null, '2026-11-20 11:00', '2026-12-04 16:30', 'normal', null],
  [15, 'R02', 'SV-02', null, 500, 'สมหญิง รักไทย', 'IN_REVIEW', 'off.reg2', '2026-11-20 15:00', '2026-12-04 16:30', 'normal', null],
  [16, 'R03', 'SV-02', null, 500, 'ปิติ มีสุข', 'IN_REVIEW', 'off.reg2', '2026-11-23 09:00', '2026-12-08 16:30', 'normal', null],
  [17, 'F01', 'SV-01', 1, 20, 'สมชาย ใจดี', 'NEED_FIX', 'off.reg1', '2026-11-23 10:00', '2026-11-27 16:30', 'paused', null],
  [18, 'R04', 'SV-02', null, 500, 'สมชาย ใจดี', 'IN_REVIEW', 'off.reg2', '2026-11-24 10:00', '2026-12-09 16:30', 'normal', null],
  [19, 'A01', 'SV-02', null, 500, 'สมหญิง รักไทย', 'APPROVED', null, '2026-11-24 14:00', '2026-12-09 16:30', 'normal', null],
  [20, 'O01', 'SV-01', 1, 20, 'สมชาย ใจดี', 'IN_REVIEW', 'off.reg1', '2026-11-25 10:00', '2026-11-30 16:30', 'overdue', null],
  [21, 'R08', 'SV-02', null, 500, 'สมหญิง รักไทย', 'IN_REVIEW', 'off.reg2', '2026-11-25 12:00', '2026-12-11 16:30', 'normal', null],
  [22, 'N02', 'SV-01', 2, 40, 'สมหญิง รักไทย', 'IN_REVIEW', 'off.reg1', '2026-11-26 10:00', '2026-12-01 16:30', 'near', null],
  [23, 'F02', 'SV-01', 1, 20, 'สมหญิง รักไทย', 'IN_REVIEW', 'off.reg1', '2026-11-26 10:30', '2026-12-03 16:30', 'normal', null],
  [24, 'N01', 'SV-01', 1, 20, 'ปิติ มีสุข', 'SUBMITTED', null, '2026-11-27 11:00', '2026-12-02 16:30', 'near', null],
  [25, 'R05', 'SV-01', 3, 60, 'สมหญิง รักไทย', 'IN_REVIEW', 'off.reg2', '2026-11-30 10:00', '2026-12-03 16:30', 'normal', null],
  [26, 'R07', 'SV-01', 5, 100, 'สมชาย ใจดี', 'IN_REVIEW', 'off.reg2', '2026-11-30 16:29', '2026-12-03 16:30', 'normal', null],
  [27, 'R06', 'SV-01', 1, 20, 'ปิติ มีสุข', 'IN_REVIEW', 'off.reg2', '2026-11-30 16:30', '2026-12-04 16:30', 'normal', null],
  [28, 'S01', 'SV-01', 1, 20, 'สมหญิง รักไทย', 'SUBMITTED', null, '2026-12-01 08:10', '2026-12-04 16:30', 'normal', null],
  [29, 'S02', 'SV-01', 1, 20, 'ปิติ มีสุข', 'SUBMITTED', null, '2026-12-01 08:20', '2026-12-04 16:30', 'normal', null],
  [30, 'S03', 'SV-01', 1, 20, 'สมชาย ใจดี', 'SUBMITTED', null, '2026-12-01 08:30', '2026-12-04 16:30', 'normal', null],
];
const SLA = { 'SV-01': 3, 'SV-02': 10, 'SV-03': 15 };

// วันทำการ (DECISIONS §0 §8) ไว้ตรวจว่ากำหนดเสร็จ/ระดับในตารางสอดคล้องกัน
const dkey = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const addDay = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const isWork = (k) => { const d = new Date(`${k}T00:00:00Z`).getUTCDay(); return d >= 1 && d <= 5 && !HOL.has(k); };
const nextWork = (k) => { let x = addDay(k, 1); while (!isWork(x)) x = addDay(x, 1); return x; };
const workdaysBetween = (a, b) => { let n = 0; for (let x = addDay(a, 1); x <= b; x = addDay(x, 1)) if (isWork(x)) n += 1; return n; };
function computeDue(paidIso, sla, extra) {
  const ms = Date.parse(paidIso); const k = dkey(ms); const hm = new Date(ms + 7 * 3600e3).toISOString().slice(11, 16);
  let d = isWork(k) && hm < '16:30' ? k : nextWork(k);
  for (let i = 0; i < sla + extra; i += 1) d = nextWork(d);
  return `${d}T16:30:00+07:00`;
}
function level(c) {
  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(c.status)) return 'closed';
  if (c.status === 'NEED_FIX') return 'paused';
  if (NOW_MS > Date.parse(c.due_at)) return 'overdue';
  return workdaysBetween(dkey(NOW_MS), c.due_at.slice(0, 10)) <= 1 ? 'near' : 'normal';
}

eq('§4 จำนวนคำขอ', count('SELECT COUNT(*) n FROM cases'), 30);
const pausedBy = {};
for (const r of all('SELECT case_no, paused_days FROM case_returns WHERE paused_days IS NOT NULL')) pausedBy[r.case_no] = (pausedBy[r.case_no] || 0) + r.paused_days;
for (const [seq, tag, svc, qa, fee, who, status, owner, paid, due, lvl, closed] of ROWS) {
  const c = one('SELECT * FROM cases WHERE case_no = ?', cn(seq));
  if (!c) { fails.push(`§4.1 ไม่พบ ${cn(seq)}`); continue; }
  const L = `§4.1 ${cn(seq)} ${tag}`;
  eq(`${L} บริการ/ค่าธรรมเนียม/ข้อมูล`, [c.service_id, c.fee, svc === 'SV-01' ? c.qty : svc === 'SV-03' ? c.area_sqm : null], [svc, fee, qa]);
  eq(`${L} ผู้ยื่น`, c.user_id, uidByName[who]);
  // ใบปิดแล้วไม่ตรวจผู้ถือ (ตาราง 4.1 = "(ประวัติ)")
  eq(`${L} สถานะ/ผู้ถือ`, [c.status, lvl === 'closed' ? null : c.owner], [status, owner]);
  eq(`${L} ชำระ/กำหนด/ใบเสร็จ`, [c.paid_at, c.due_at, c.receipt_no, c.year_be, c.seq], [T(paid), T(due), `RC-2569-${String(seq).padStart(6, '0')}`, 2569, seq]);
  eq(`${L} ปิดงาน`, status === 'CANCELLED' ? c.cancelled_at : c.closed_at, status === 'CANCELLED' ? T('2026-11-09 15:00') : T(closed));
  eq(`${L} ระดับ ณ 1 ธ.ค. 09:00`, level(c), lvl);
  eq(`${L} step`, c.step === null ? null : typeof c.step, svc === 'SV-03' ? 'number' : null);
  eq(`${L} กำหนดเสร็จสอดคล้องกฎวันทำการ`, c.due_at, computeDue(c.paid_at, SLA[svc], pausedBy[c.case_no] || 0));
  const rc = one('SELECT amount, issued_at, case_no FROM receipts WHERE receipt_no = ?', c.receipt_no);
  eq(`${L} ใบเสร็จ`, rc, { amount: fee, issued_at: T(paid), case_no: cn(seq) });
}
// รายละเอียดพิเศษ §4.3
const C = (n) => one('SELECT * FROM cases WHERE case_no = ?', cn(n));
eq('§4.3 W01 ขั้น 2/3 ฝ่ายโยธา ไม่มีผู้รับ · ผู้ออกเอกสาร off.reg1', [C(10).dept, C(10).step, C(10).owner, C(10).issuer], ['works', 2, null, 'off.reg1']);
eq('§4.3 P02 ขั้น 3/3 · ทะเบียน off.reg1 · โยธา off.works1', [C(11).dept, C(11).step, C(11).registry_officer, C(11).works_officer], ['head', 3, 'off.reg1', 'off.works1']);
eq('§4.3 R09 ขั้น 1/3', [C(12).dept, C(12).step], ['registry', 1]);
eq('§4.3 P01 ผู้ออกเอกสาร off.reg1', [C(14).dept, C(14).issuer], ['head', 'off.reg1']);
eq('§4.3 A01 APPROVED โดย head1 30 พ.ย. 15:00 ผู้ออก off.reg1 owner ว่าง', [C(19).approved_by, C(19).approved_at, C(19).issuer, C(19).owner, C(19).dept],
  ['head1', T('2026-11-30 15:00'), 'off.reg1', null, 'registry']);
eq('§4.3 F01 ตีกลับ 2 ครั้ง เส้นตาย 4 ธ.ค. 14:00', [C(17).return_count, C(17).fix_deadline, C(17).need_fix_at], [2, '2026-12-04T14:00:00+07:00', T('2026-11-27 14:00')]);
eq('§4.3 F02 return-count 2 ไม่มีเส้นตาย', [C(23).return_count, C(23).fix_deadline], [2, null]);
eq('§4.3 O01 ไม่เคยถูกตีกลับ', C(20).return_count, 0);
eq('§4.3 X01 ยกเลิกเอง', [C(9).cancel_reason, C(9).owner], ['citizen', null]);
eq('§4.1 สมชาย 10 · สมหญิง 11 · มานะ 0 · ปิติ 9', ['สมชาย ใจดี', 'สมหญิง รักไทย', 'มานะ ตั้งใจ', 'ปิติ มีสุข'].map((n) => count('SELECT COUNT(*) n FROM cases WHERE user_id=?', uidByName[n])), [10, 11, 0, 9]);

// §4.4 ตีกลับ
eq('§4.4 ประวัติตีกลับ', all('SELECT case_no, n, returned_at, resubmitted_at, paused_days, reason FROM case_returns ORDER BY case_no, n').map(Object.values), [
  [cn(17), 1, T('2026-11-24 11:00'), T('2026-11-25 10:00'), 1, 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่'],
  [cn(17), 2, T('2026-11-27 14:00'), null, null, 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข'],
  [cn(23), 1, T('2026-11-27 10:00'), T('2026-11-30 10:00'), 1, 'ภาพเอกสารเบลอ อ่านเลขไม่ได้'],
  [cn(23), 2, T('2026-11-30 14:00'), T('2026-12-01 08:30'), 1, 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน'],
]);
for (const r of all('SELECT * FROM case_returns WHERE resubmitted_at IS NOT NULL')) {
  eq(`§4.4 ${r.case_no} ครั้งที่ ${r.n} หยุดนับ = วันทำการใน (ตีกลับ, ส่งแก้]`, r.paused_days, workdaysBetween(r.returned_at.slice(0, 10), r.resubmitted_at.slice(0, 10)));
}
eq('§4 ทุกคำขอมีไทม์ไลน์เริ่มด้วย SUBMIT', count("SELECT COUNT(DISTINCT case_no) n FROM case_events WHERE event='SUBMIT'"), 30);

// ไฟล์แนบ
const REQ = { 'SV-01': ['id-card'], 'SV-02': ['id-card', 'map'], 'SV-03': ['deed', 'id-card', 'plan'] };
for (const c of all('SELECT case_no, service_id FROM cases')) {
  eq(`§4.1 ไฟล์แนบ ${c.case_no}`, all('SELECT doc_key FROM files WHERE case_no=? ORDER BY doc_key', c.case_no).map((r) => r.doc_key), REQ[c.service_id]);
}
eq('§4.2 ไฟล์ของ DR-0002', all("SELECT doc_key FROM files WHERE draft_id='DR-0002' ORDER BY doc_key").map((r) => r.doc_key), ['id-card', 'map']);
eq('§4.2 DR-0001 ยังไม่แนบไฟล์', count("SELECT COUNT(*) n FROM files WHERE draft_id='DR-0001'"), 0);
eq('§10 ไฟล์ทั้งหมด (16×1 + 10×2 + 4×3 + 2)', count('SELECT COUNT(*) n FROM files'), 50);
{
  let bad = [];
  for (const f of all('SELECT * FROM files')) {
    const p = path.join(uploadDir, f.storage_name);
    if (!fs.existsSync(p)) { bad.push(`${f.id}: ไม่มีไฟล์`); continue; }
    const b = fs.readFileSync(p);
    if (b.length !== 1024 || f.size !== 1024 || b.subarray(0, 5).toString() !== '%PDF-' || f.mime !== 'application/pdf' || f.name !== `${f.doc_key}.pdf`) bad.push(f.id);
  }
  eq('§4.1 ไฟล์ seed เป็น PDF จริง 1,024 ไบต์บนดิสก์', bad, []);
  eq('§10 ที่เก็บไฟล์มีเฉพาะไฟล์ seed', fs.readdirSync(uploadDir).length, 50);
}

// ---------- §4.2 ร่าง · §6 ชำระเงิน ----------
eq('§4.2 ร่าง', all('SELECT id, user_id, service_id, status, qty, fee, fee_locked, case_no FROM drafts ORDER BY id').map(Object.values), [
  ['DR-0001', uidByName['สมชาย ใจดี'], 'SV-01', 'DRAFT', 2, 40, null, null],
  ['DR-0002', uidByName['สมชาย ใจดี'], 'SV-02', 'PENDING_PAYMENT', null, 500, 500, null],
]);
eq('§6 รายการชำระค้าง', all('SELECT ref, draft_id, amount, status, qr_created_at, qr_expires_at, paid_at FROM payments').map(Object.values), [
  ['PP-0001', 'DR-0002', 500, 'PENDING', '2026-12-01T08:55:00+07:00', '2026-12-01T09:10:00+07:00', null],
]);
eq('§6 ใบเสร็จ 30 ใบ', count('SELECT COUNT(*) n FROM receipts'), 30);

// ---------- §5 เอกสาร ----------
{
  const d = one('SELECT * FROM documents');
  eq('§5 จำนวนเอกสาร', count('SELECT COUNT(*) n FROM documents'), 1);
  eq('§5 DOC-2569-000001', [d.doc_no, d.case_no, d.verify_code, d.service_id, d.applicant_masked, d.issued_at, d.valid_until, d.signer, d.signer_username],
    ['DOC-2569-000001', cn(5), 'K7M2Q9XA', 'SV-01', 'สมชาย ใ***', '2026-11-05T10:00:00+07:00', '2027-02-02', 'เจ้าหน้าที่ทะเบียน 1', 'off.reg1']);
  const p = JSON.parse(d.payload);
  const key = process.env.DOC_HMAC_KEY || 'egov-test-doc-hmac-key-not-for-production';
  const msg = ['docNo', 'caseNo', 'applicant', 'serviceId', 'issuedAt', 'validUntil', 'signer'].map((k) => p[k]).join('|');
  eq('§5 payload', p, { docNo: 'DOC-2569-000001', caseNo: cn(5), applicant: 'สมชาย ใจดี', serviceId: 'SV-01',
    issuedAt: '2026-11-05T10:00:00+07:00', validUntil: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1' });
  eq('§5 ลายเซ็น HMAC-SHA256 base64url ตรง', d.signature, crypto.createHmac('sha256', key).update(msg).digest('base64url'));
  eq('§5 วันหมดอายุ = ออก + 89 วัน', addDay('2026-11-05', 89), '2027-02-02');
}

// ---------- §12 ตัวนับ ----------
eq('§12 ตัวนับ', Object.fromEntries(all('SELECT name, value FROM counters ORDER BY name').map((r) => [r.name, r.value])),
  { 'case:2569': 30, 'doc:2569': 1, draft: 2, payment: 1, 'receipt:2569': 30 });

// ---------- §10 ของที่ว่าง ----------
for (const t of ['audit_log', 'notifications', 'sessions', 'otp_attempts']) eq(`§10 ${t} ว่าง`, count(`SELECT COUNT(*) n FROM ${t}`), 0);

// ---------- §9 คิว ----------
const OPEN = "('SUBMITTED','IN_REVIEW','APPROVED')";
const queue = (dept) => all(`SELECT case_no, owner, status FROM cases WHERE dept=? AND status IN ${OPEN} ORDER BY due_at, case_no`, dept);
eq('§9.1 คิวทะเบียน 17 แถว (ลำดับ)', queue('registry').map((r) => r.case_no.slice(-2)),
  ['20', '22', '24', '23', '25', '26', '13', '15', '27', '28', '29', '30', '16', '18', '19', '12', '21']);
eq('§9.1 ผู้ถือในคิวทะเบียน', queue('registry').map((r) => r.owner || ''),
  ['off.reg1', 'off.reg1', '', 'off.reg1', 'off.reg2', 'off.reg2', 'off.reg2', 'off.reg2', 'off.reg2', '', '', '', 'off.reg2', 'off.reg2', '', 'off.reg2', 'off.reg2']);
eq('§9.1 unclaimed', all("SELECT case_no FROM cases WHERE dept='registry' AND status IN ('SUBMITTED','IN_REVIEW') AND owner IS NULL ORDER BY due_at, case_no").map((r) => r.case_no.slice(-2)),
  ['24', '28', '29', '30']);
const mine = (u) => count("SELECT COUNT(*) n FROM cases WHERE status='IN_REVIEW' AND owner=?", u);
eq('§9.1/§7.1 งานในมือ off.reg1 · off.reg2 · off.works1', [mine('off.reg1'), mine('off.reg2'), mine('off.works1')], [3, 9, 0]);
eq('§9.2 คิวโยธา', queue('works').map((r) => [r.case_no, r.owner]), [[cn(10), null]]);
eq('§9.3 /head/approvals', all("SELECT case_no FROM cases WHERE status='PENDING_APPROVAL' ORDER BY due_at, case_no").map((r) => r.case_no), [cn(14), cn(11)]);

// ---------- §7 Dashboard ----------
const inPeriod = (iso, p) => iso && iso.slice(0, p.length) === p;
function dash(period, svc) {
  const cs = all('SELECT * FROM cases').filter((c) => svc === 'ALL' || c.service_id === svc);
  const received = cs.filter((c) => inPeriod(c.paid_at, period)).length;
  const closed = cs.filter((c) => ['COMPLETED', 'REJECTED'].includes(c.status) && inPeriod(c.closed_at, period));
  const ontime = closed.filter((c) => Date.parse(c.closed_at) <= Date.parse(c.due_at)).length;
  const open = cs.filter((c) => ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'].includes(c.status));
  const overdue = open.filter((c) => c.status !== 'NEED_FIX' && NOW_MS > Date.parse(c.due_at)).length;
  const pct = closed.length ? (Math.round((ontime / closed.length) * 1000) / 10).toFixed(1) + '%' : '–';
  return [received, closed.length, ontime, pct, open.length, overdue];
}
const DASH = [
  ['2026-12', 'ALL', [3, 0, 0, '–', 21, 1]], ['2026-12', 'SV-01', [3, 0, 0, '–', 11, 1]],
  ['2026-12', 'SV-02', [0, 0, 0, '–', 7, 0]], ['2026-12', 'SV-03', [0, 0, 0, '–', 3, 0]],
  ['2026-10', 'ALL', [1, 1, 1, '100.0%', 21, 1]], ['2026-11', 'ALL', [26, 7, 6, '85.7%', 21, 1]],
  ['2026-11', 'SV-01', [12, 3, 3, '100.0%', 11, 1]], ['2026-11', 'SV-02', [10, 3, 2, '66.7%', 7, 0]],
  ['2026-11', 'SV-03', [4, 1, 1, '100.0%', 3, 0]], ['2026', 'ALL', [30, 8, 7, '87.5%', 21, 1]],
  ['2026', 'SV-01', [16, 4, 4, '100.0%', 11, 1]], ['2026', 'SV-02', [10, 3, 2, '66.7%', 7, 0]], ['2026', 'SV-03', [4, 1, 1, '100.0%', 3, 0]],
];
for (const [p, s, want] of DASH) eq(`§7 dashboard ${p} ${s} [รับ,ปิด,ทัน,%,คงค้าง,เกิน]`, dash(p, s), want);
eq('§7.1 คงค้างแยกสถานะ', all(`SELECT status, COUNT(*) n FROM cases WHERE status IN ('SUBMITTED','IN_REVIEW','NEED_FIX','PENDING_APPROVAL','APPROVED') GROUP BY status ORDER BY status`)
  .map((r) => [r.status, r.n]), [['APPROVED', 1], ['IN_REVIEW', 13], ['NEED_FIX', 1], ['PENDING_APPROVAL', 2], ['SUBMITTED', 4]]);

// ---------- §8 ผู้รับแจ้งเตือนที่คาด (คำนวณจาก seed + กฎ A-31) ----------
{
  const regStaff = ['off.reg1', 'off.reg2']; const worksStaff = ['off.works1'];
  const got = {};
  const push = (u, c, l) => { (got[u] = got[u] || []).push(`${c.slice(-6)} ${l}`); };
  for (const c of all('SELECT * FROM cases ORDER BY case_no')) {
    const l = level(c);
    if (l !== 'near' && l !== 'overdue') continue;
    let rcpt;
    if (c.status === 'PENDING_APPROVAL') rcpt = ['head1'];
    else if (c.status === 'APPROVED') rcpt = [c.issuer];
    else if (c.owner) rcpt = [c.owner];
    else rcpt = c.dept === 'works' ? worksStaff : regStaff;
    if (l === 'overdue' && !rcpt.includes('head1')) rcpt = rcpt.concat('head1');
    for (const u of rcpt) push(u, c.case_no, l);
  }
  eq('§8 แจ้งเตือน ณ 1 ธ.ค. 09:00', got, {
    'off.reg1': ['000020 overdue', '000022 near', '000024 near'], 'head1': ['000020 overdue'], 'off.reg2': ['000024 near'],
  });
}

// ---------- NFR-04 / PDPA: ไม่มีเลข 13 หลักหรือเบอร์โทรตรง ๆ ในฐานข้อมูล ----------
{
  const dump = [];
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    for (const r of all(`SELECT * FROM "${name}"`)) dump.push(Object.values(r).map((v) => (v === null ? '' : String(v))).join(' '));
  }
  const text = dump.join('\n');
  eq('NFR-04 ไม่มีตัวเลข 10 หลักขึ้นไปติดกันในฐานข้อมูล', (text.match(/\d{10,}/g) || []), []);
  eq('NFR-04 ไม่มีเลขบัตรรูปแบบมีขีด', (text.match(/\d-\d{4}-\d{5}-\d{2}-\d/g) || []), []);
}

// ---------- สรุป ----------
if (tmp) { try { db.close(); } catch { /* ignore */ } fs.rmSync(tmp, { recursive: true, force: true }); }
if (fails.length) {
  console.error(`check-seed: ไม่ผ่าน ${fails.length} ข้อ (ผ่าน ${pass})\n`);
  for (const f of fails) console.error(`✗ ${f}`);
  process.exit(1);
}
console.log(`check-seed: ผ่านทั้งหมด ${pass} ข้อ · บัญชี 11 · บริการ 3 · วันหยุด 4 · คำขอ 30 · ร่าง 2 · ไฟล์ 50 · ใบเสร็จ 30 · เอกสาร 1 · ชำระค้าง 1 · คิวทะเบียน 17 · dashboard ธ.ค. 3/0/–/21/1`);
