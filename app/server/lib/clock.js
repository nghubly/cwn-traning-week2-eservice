'use strict';
/**
 * นาฬิกาของระบบ (แหล่งเวลาเดียวของกฎธุรกิจทั้งหมด) · เขตเวลา Asia/Bangkok (+07:00 ไม่มี DST)
 *
 * - TEST_MODE=1 → นาฬิกาแช่แข็ง เริ่มที่ 2026-12-01T09:00:00+07:00 · เปลี่ยนด้วย PUT /api/test/clock
 * - ไม่ตั้ง TEST_MODE → เวลาเครื่อง (อ่านที่ไฟล์นี้ไฟล์เดียว ห้ามเรียก Date.now()/new Date() ในกฎธุรกิจ)
 *
 * ค่าเวลาที่เก็บใน DB และส่งทาง API = สตริง ISO "+07:00" (ใช้ toIso) · ห้ามเก็บ epoch ms
 * (epoch ms มี 13 หลัก ชนกับการตรวจเลขบัตร 13 หลักใน TC-NFR-04/PDPA)
 */

const OFFSET_MS = 7 * 3600 * 1000;
const DEFAULT_NOW = '2026-12-01T09:00:00+07:00';
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

const testMode = process.env.TEST_MODE === '1';
let frozenMs = testMode ? Date.parse(DEFAULT_NOW) : null;

// ISO 8601 ที่ต้องมี offset (Z หรือ ±hh:mm) · วินาที/มิลลิวินาทีไม่บังคับ
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** แปลงสตริง ISO ที่มี offset → Date · ไม่ถูกต้อง/ไม่มี offset → null */
function parseIso(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se = '0'] = m;
  const off = m[8];
  if (+mo < 1 || +mo > 12 || +d < 1 || +h > 23 || +mi > 59 || +se > 59) return null;
  if (off !== 'Z' && (+off.slice(1, 3) > 14 || +off.slice(4, 6) > 59)) return null;
  const dim = new Date(Date.UTC(+y, +mo, 0)).getUTCDate();
  if (+d > dim) return null;
  const ms = Date.parse(s.trim());
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const d = parseIso(v);
    if (!d) throw new Error(`clock: invalid ISO time "${v}"`);
    return d.getTime();
  }
  throw new Error('clock: unsupported time value');
}

/** เวลาปัจจุบัน (Date) */
function now() {
  return new Date(frozenMs !== null ? frozenMs : Date.now());
}

/** เวลาปัจจุบันเป็น ISO +07:00 */
function nowIso() {
  return toIso(now());
}

/** ตั้งนาฬิกา (แช่แข็ง) · รับ ISO ที่มี offset · คืน ISO +07:00 หรือ null ถ้าไม่ถูกต้อง */
function setNow(iso) {
  const d = parseIso(iso);
  if (!d) return null;
  frozenMs = d.getTime();
  return toIso(d);
}

/** กลับค่าเริ่มต้นหลัง reset (TEST_MODE แช่แข็งที่ 2026-12-01T09:00:00+07:00) */
function reset() {
  frozenMs = testMode ? Date.parse(DEFAULT_NOW) : null;
  return nowIso();
}

/** Date|ms|ISO → "YYYY-MM-DDTHH:mm:ss+07:00" */
function toIso(v) {
  if (v === null || v === undefined) return null;
  const t = new Date(toMs(v) + OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+07:00`;
}

/** ส่วนประกอบเวลาไทย: {y, m(1-12), d, hh, mm, ss, dow(0=อา.), date:'YYYY-MM-DD', time:'HH:mm:ss'} */
function parts(v) {
  const t = new Date(toMs(v) + OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const r = {
    y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    hh: t.getUTCHours(), mm: t.getUTCMinutes(), ss: t.getUTCSeconds(), dow: t.getUTCDay(),
  };
  r.date = `${p(r.y, 4)}-${p(r.m)}-${p(r.d)}`;
  r.time = `${p(r.hh)}:${p(r.mm)}:${p(r.ss)}`;
  return r;
}

/** สร้าง Date จากเวลาไทย (เดือน 1-12) */
function bkk(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - OFFSET_MS);
}

/** 'YYYY-MM-DD' ตามเวลาไทย */
function dateKey(v) {
  return parts(v).date;
}

/** ปี พ.ศ. ตามเวลาไทย */
function beYear(v = now()) {
  return parts(v).y + 543;
}

/** รูปแบบบนจอ: "4 ธ.ค. 2569 16:30" (ไม่มีวินาที) */
function formatThai(v) {
  if (v === null || v === undefined || v === '') return '';
  const p = parts(v);
  return `${p.d} ${TH_MONTHS[p.m - 1]} ${p.y + 543} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/** รูปแบบวันที่อย่างเดียว: "2 ก.พ. 2570" · รับ Date/ISO หรือ 'YYYY-MM-DD' */
function formatThaiDate(v) {
  if (v === null || v === undefined || v === '') return '';
  let y, m, d;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) [y, m, d] = v.split('-').map(Number);
  else ({ y, m, d } = parts(v));
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

/** บวกเวลาเป็นมิลลิวินาที คืน Date */
function addMs(v, ms) {
  return new Date(toMs(v) + ms);
}

/** เปรียบเทียบเวลา: <0 a ก่อน b · 0 เท่ากัน · >0 a หลัง b */
function cmp(a, b) {
  return toMs(a) - toMs(b);
}

module.exports = {
  DEFAULT_NOW, TH_MONTHS, OFFSET_MS,
  now, nowIso, setNow, reset, isFrozen: () => frozenMs !== null,
  parseIso, toIso, toMs, parts, bkk, dateKey, beYear, formatThai, formatThaiDate, addMs, cmp,
};
