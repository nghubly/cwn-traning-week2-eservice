'use strict';
/**
 * BUG_MODE=B03,B07 (คั่นด้วย , ) เปิดบั๊กตาม BUGS.md · ไม่ตั้ง = เว็บถูกต้อง 100%
 * ใช้: const { isBug } = require('../lib/bugmode'); if (isBug('B03')) { ...พฤติกรรมผิด... }
 * บั๊กกระทบเฉพาะการคำนวณ/ตรวจสิทธิ์ใหม่ ไม่กระทบข้อมูล seed (A-35)
 */

const VALID = new Set(Array.from({ length: 12 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`));

function parse(raw) {
  return new Set(
    String(raw || '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .map((s) => (/^B\d$/.test(s) ? `B0${s.slice(1)}` : s)) // B3 → B03
      .filter((s) => VALID.has(s)),
  );
}

const active = parse(process.env.BUG_MODE);

/** true ถ้าบั๊กรหัสนี้เปิดอยู่ เช่น isBug('B03') */
function isBug(code) {
  return active.has(String(code).toUpperCase());
}

/** รายการบั๊กที่เปิดอยู่ (เรียงรหัส) */
function list() {
  return [...active].sort();
}

module.exports = { isBug, list, parse };
