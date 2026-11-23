'use strict';
/** รูปแบบแสดงผลกลาง (CONTRACT 0.2–0.4 · ตาราง 4) */
const clock = require('./clock');

/** 1010 → "฿1,010" */
function baht(n) {
  return `฿${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

const STATUS_TH = {
  DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
};
const LEVEL_TH = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
const ROLE_TH = {
  citizen: 'ประชาชน', officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย', executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ',
};
const LANDING = {
  citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals', executive: '/dashboard', auditor: '/audit', admin: '/admin/services',
};
const SERVICE_TH = { 'SV-01': 'ขอหนังสือรับรอง', 'SV-02': 'ขออนุญาตประกอบกิจการ', 'SV-03': 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร' };

module.exports = {
  baht, STATUS_TH, LEVEL_TH, ROLE_TH, LANDING, SERVICE_TH,
  dateTh: clock.formatThai, dateOnlyTh: clock.formatThaiDate, iso: clock.toIso,
};
