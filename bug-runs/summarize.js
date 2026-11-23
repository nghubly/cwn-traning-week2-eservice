// สรุปผล Playwright JSON หนึ่งรอบ: จำนวนผ่าน/ล้ม + TC ที่ล้ม + บรรทัดแรกของข้อความ assert
// ปิดบังตัวเลข 13 หลัก/เบอร์ 10 หลักก่อนพิมพ์ (ข้อมูลทดสอบเป็นข้อมูลสมมติ แต่ไม่พิมพ์เลขเต็มออกมา)
const fs = require('fs');
const file = process.argv[2];
const short = process.argv.includes('--short');
if (!fs.existsSync(file)) { console.log('no result file'); process.exit(0); }
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const mask = (s) => String(s || '')
  .replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/\d-?\d{4}-?\d{5}-?\d{2}-?\d/g, '<id>')
  .replace(/\b0\d{9}\b/g, '<mobile>');
const rows = [];
const walk = (s) => {
  for (const sp of s.specs || []) {
    const tc = (sp.title.match(/^TC-[A-Z]+-\d{2}/) || [sp.title])[0];
    for (const t of sp.tests) {
      const res = t.results[t.results.length - 1] || {};
      const msg = mask((res.error && res.error.message) || '').split('\n').filter((l) => l.trim()).slice(0, 6).join(' | ');
      rows.push({ tc, status: res.status, msg });
    }
  }
  (s.suites || []).forEach(walk);
};
r.suites.forEach(walk);
const failed = rows.filter((x) => x.status !== 'passed');
if (short) {
  console.log(`${rows.length - failed.length} passed · ${failed.length} failed${failed.length ? ': ' + failed.map((f) => f.tc).join(' ') : ''}`);
} else {
  console.log(JSON.stringify({ total: rows.length, passed: rows.length - failed.length, failed: failed.map((f) => ({ tc: f.tc, status: f.status, msg: f.msg.slice(0, 600) })) }, null, 1));
}
