'use strict';
/**
 * จุดเกี่ยว (hook) ให้บล็อกอื่นลงทะเบียน โดยไม่ต้องแก้ app.js
 *
 *  onEveryRequest(fn)  → fn(req) ทำงานก่อน route ทุก request ยกเว้น /api/test/* และไฟล์ static
 *                         (CONTRACT 0.7: ประเมินแจ้งเตือน SLA + ยกเลิกอัตโนมัติ NEED_FIX เลย 168 ชม.)
 *                         ลำดับ = ลำดับการลงทะเบียน · ใส่ { order } เพื่อกำหนดเอง (น้อยทำก่อน)
 *                         แนะนำ: ยกเลิกอัตโนมัติ order 10 · แจ้งเตือน SLA order 20
 *  onReset(fn)         → fn() ทำงานตอน POST /api/test/reset หลังล้าง DB+ไฟล์ และก่อน seed
 *                         (ใช้ล้าง cache/ตัวแปรในหน่วยความจำของโมดูล)
 *  onAfterSeed(fn)     → fn() หลัง seed เสร็จ
 */
const lists = { request: [], reset: [], afterSeed: [] };

function add(list, fn, opts = {}) {
  if (typeof fn !== 'function') throw new TypeError('hook must be a function');
  list.push({ fn, order: opts.order ?? 100, i: list.length });
  list.sort((a, b) => a.order - b.order || a.i - b.i);
}

module.exports = {
  onEveryRequest: (fn, opts) => add(lists.request, fn, opts),
  onReset: (fn, opts) => add(lists.reset, fn, opts),
  onAfterSeed: (fn, opts) => add(lists.afterSeed, fn, opts),
  runRequest(req) { for (const h of lists.request) h.fn(req); },
  runReset() { for (const h of lists.reset) h.fn(); },
  runAfterSeed() { for (const h of lists.afterSeed) h.fn(); },
};
