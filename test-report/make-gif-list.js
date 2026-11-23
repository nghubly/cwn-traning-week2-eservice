// Builds gif-list.txt (src|dst, relative to test-report/) for P1 TCs from results.json.
// One GIF per TC: the longest video recorded in that test (the main actor's session).
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const P2 = new Set(['TC-AUTH-04', 'TC-SUBMIT-03', 'TC-PAY-04', 'TC-DASH-03', 'TC-RBAC-04', 'TC-RBAC-06', 'TC-NFR-03', 'TC-NFR-04']);
const results = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));

const rows = [];
const walk = (suite) => {
  for (const spec of suite.specs || []) {
    const tc = (spec.title.match(/^TC-[A-Z]+-\d{2}/) || [])[0];
    for (const t of spec.tests) {
      const res = t.results[t.results.length - 1] || {};
      // วิดีโออยู่ใน artifacts/<โฟลเดอร์ของ test ที่มีรหัส TC>/videos/*.webm (helper อัดเองด้วย RECORD_VIDEO=1)
      const art = path.join(DIR, 'artifacts');
      const folder = fs.readdirSync(art).find((f) => tc && f.includes(tc + '-'));
      const vdir = folder ? path.join(art, folder, 'videos') : null;
      const videos = vdir && fs.existsSync(vdir)
        ? fs.readdirSync(vdir).filter((f) => f.endsWith('.webm')).map((f) => ({ path: path.join(vdir, f) }))
        : [];
      videos.sort((a, b) => fs.statSync(b.path).size - fs.statSync(a.path).size);
      rows.push({ tc, status: res.status, duration: res.duration, video: videos[0] && videos[0].path, videos: videos.length });
    }
  }
  (suite.suites || []).forEach(walk);
};
results.suites.forEach(walk);

fs.mkdirSync(path.join(DIR, 'gif'), { recursive: true });
const lines = rows
  .filter((r) => r.tc && !P2.has(r.tc) && r.video)
  .map((r) => `${path.relative(DIR, r.video).split(path.sep).join('/')}|gif/${r.tc}.gif`);
fs.writeFileSync(path.join(DIR, 'gif-list.txt'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(DIR, 'tc-index.json'), JSON.stringify(rows.map((r) => ({ tc: r.tc, p: P2.has(r.tc) ? 'P2' : 'P1', status: r.status, durationMs: r.duration, videos: r.videos })), null, 1));
console.log(`TCs=${rows.length} P1 with video=${lines.length}`);
