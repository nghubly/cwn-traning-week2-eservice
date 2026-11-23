// สร้าง test-report/index.html จาก results.json (สรุป 51 TC + ลิงก์ GIF ของ P1 + ลิงก์รายงาน Playwright เต็ม)
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const results = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
const P2 = new Set(['TC-AUTH-04', 'TC-SUBMIT-03', 'TC-PAY-04', 'TC-DASH-03', 'TC-RBAC-04', 'TC-RBAC-06', 'TC-NFR-03', 'TC-NFR-04']);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const rows = [];
const walk = (suite) => {
  for (const spec of suite.specs || []) {
    const tc = (spec.title.match(/^TC-[A-Z]+-\d{2}/) || [''])[0];
    const name = spec.title.replace(/^TC-[A-Z]+-\d{2}\s*·\s*/, '');
    for (const t of spec.tests) {
      const r = t.results[t.results.length - 1] || {};
      const gif = fs.existsSync(path.join(DIR, 'gif', tc + '.gif')) ? `gif/${tc}.gif` : null;
      rows.push({ tc, name, p: P2.has(tc) ? 'P2' : 'P1', status: r.status, sec: ((r.duration || 0) / 1000).toFixed(1), gif });
    }
  }
  (suite.suites || []).forEach(walk);
};
results.suites.forEach(walk);

const passed = rows.filter((r) => r.status === 'passed').length;
const s = results.stats || {};
const started = s.startTime ? new Date(s.startTime).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-';

const tr = rows.map((r) => `<tr>
<td class="tc">${esc(r.tc)}</td><td>${esc(r.name)}</td><td>${r.p}</td>
<td class="${r.status === 'passed' ? 'ok' : 'bad'}">${r.status === 'passed' ? '✅ ผ่าน' : '❌ ' + esc(r.status)}</td>
<td class="num">${r.sec}</td>
<td>${r.gif ? `<details><summary>ดู GIF</summary><img loading="lazy" src="${r.gif}" alt="การรัน ${esc(r.tc)}"></details>` : (r.p === 'P1' ? '<span class="muted">API อย่างเดียว ไม่มีหน้าจอ</span>' : '<span class="muted">P2</span>')}</td>
</tr>`).join('\n');

const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ผลทดสอบ e-Service</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b7280;--line:#e5e7eb;--ok:#047857;--bad:#b91c1c;--head:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e5e7eb;--muted:#9ca3af;--line:#2d313a;--ok:#34d399;--bad:#f87171;--head:#1b1e25}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,"Noto Sans Thai",sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.sum{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}.sum b{font-size:28px;display:block}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--head);position:sticky;top:0}.tc{white-space:nowrap;font-family:ui-monospace,monospace}.num{text-align:right}
.ok{color:var(--ok);white-space:nowrap}.bad{color:var(--bad)}img{max-width:100%;margin-top:6px;border:1px solid var(--line)}
a{color:inherit}
</style></head><body><main>
<h1>ผลทดสอบ Playwright · e-Service กลาง เทศบาลนครสุขใจ (หน่วยงานสมมติ)</h1>
<p class="muted">TEST_MODE=1 · ไม่ตั้ง BUG_MODE · docker compose · เริ่มรัน ${esc(started)} · ข้อมูลทดสอบเป็นข้อมูลสมมติตาม TEST-DATA</p>
<div class="sum"><div><b>${passed}/${rows.length}</b>ผ่าน</div><div><b>${s.unexpected || 0}</b>ล้ม</div><div><b>${s.flaky || 0}</b>flaky</div><div><b>${((s.duration || 0) / 60000).toFixed(1)} นาที</b>เวลารวม</div></div>
<p>รายงานเต็มของ Playwright (ขั้นตอนทุก step): <a href="html/index.html">html/index.html</a> · ข้อมูลดิบ: <a href="results.json">results.json</a></p>
<div class="wrap"><table><thead><tr><th>TC</th><th>ชื่อ</th><th>P</th><th>ผล</th><th>วินาที</th><th>GIF (P1)</th></tr></thead><tbody>
${tr}
</tbody></table></div>
</main></body></html>
`;
fs.writeFileSync(path.join(DIR, 'index.html'), html);
console.log(`index.html: ${passed}/${rows.length} passed, gifs=${rows.filter((r) => r.gif).length}`);
