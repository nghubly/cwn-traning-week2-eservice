#!/usr/bin/env node
'use strict';
/**
 * สรุปผล Playwright JSON จาก scripts/bug-matrix.sh เป็นตาราง triage ตาม BUGS.md §4
 * ใช้: node scripts/summarize-results.js [โฟลเดอร์ผล]   (ค่าเริ่มต้น tests/test-results/matrix)
 *      --tc <ไฟล์.json>  → พิมพ์ผลราย TC (51 แถว) ของรอบนั้น
 */
const fs = require('fs');
const path = require('path');

// BUGS.md §2: TC ที่ต้องล้ม · TC ที่อาจล้มด้วย
const EXPECT = {
  B01: { must: ['TC-FEE-01'], may: [] },
  B02: { must: ['TC-UPLOAD-01'], may: [] },
  B03: { must: ['TC-SLA-01', 'TC-SLA-02'], may: ['TC-SLA-03', 'TC-RBAC-04'] },
  B04: { must: ['TC-SLA-02'], may: [] },
  B05: { must: ['TC-PAY-01'], may: [] },
  B06: { must: ['TC-RBAC-01'], may: [] },
  B07: { must: ['TC-RBAC-02'], may: ['TC-WORKFLOW-01'] },
  B08: { must: ['TC-QUEUE-02'], may: [] },
  B09: { must: ['TC-PDPA-02'], may: [] },
  B10: { must: ['TC-DASH-02'], may: ['TC-DASH-01', 'TC-DASH-03'] },
  B11: { must: ['TC-PDPA-03', 'TC-AUDIT-01'], may: [] },
  B12: { must: ['TC-WORKFLOW-04'], may: [] },
};

function expectFor(mode) {
  const must = new Set();
  const may = new Set();
  for (const b of mode.split('+').filter(Boolean)) {
    const e = EXPECT[b];
    if (!e) continue;
    e.must.forEach((t) => must.add(t));
    e.may.forEach((t) => may.add(t));
  }
  return { must: [...must], may: [...may].filter((t) => !must.has(t)) };
}

const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

function readRun(file) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  const walk = (s) => {
    for (const x of s.suites || []) walk(x);
    for (const sp of s.specs || []) {
      for (const t of sp.tests) {
        const res = t.results[t.results.length - 1] || {};
        const tc = (sp.title.match(/TC-[A-Z]+-\d+/) || [sp.title])[0];
        const err = res.errors && res.errors[0] ? stripAnsi(res.errors[0].message) : '';
        out.push({ tc, title: sp.title, status: res.status, ms: res.duration, err, annotations: (t.annotations || []).concat(res.annotations || []) });
      }
    }
  };
  (r.suites || []).forEach(walk);
  return out;
}

/** ย่อข้อความ error ให้เหลือบรรทัดที่บอก expected/received */
function shortErr(msg) {
  const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = [];
  for (const l of lines) {
    if (/^(Error|expect|Expected|Received|Timeout|TimeoutError|Call log)/i.test(l) || /expected|received/i.test(l)) pick.push(l);
    if (pick.length >= 4) break;
  }
  return (pick.length ? pick : lines.slice(0, 3)).join(' · ').replace(/\|/g, '\\|').slice(0, 400);
}

const args = process.argv.slice(2);
if (args[0] === '--tc') {
  for (const r of readRun(args[1])) console.log(`| ${r.tc} | ${r.status === 'passed' ? '✅ passed' : '❌ ' + r.status} | ${(r.ms / 1000).toFixed(1)} s |`);
  process.exit(0);
}

const dir = args[0] || path.join(__dirname, '..', 'tests', 'test-results', 'matrix');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const mode = f.replace(/^\d+-/, '').replace(/\.json$/, '');
  const runs = readRun(path.join(dir, f));
  const failed = runs.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
  const skipped = runs.filter((r) => r.status === 'skipped');
  const passed = runs.filter((r) => r.status === 'passed');
  const exp = mode === 'none' ? { must: [], may: [] } : expectFor(mode);
  const failedSet = new Set(failed.map((r) => r.tc));
  const missed = exp.must.filter((t) => !failedSet.has(t));
  const extra = [...failedSet].filter((t) => !exp.must.includes(t) && !exp.may.includes(t));
  const sideOk = [...failedSet].filter((t) => exp.may.includes(t));
  const ok = missed.length === 0 && extra.length === 0;
  console.log(`\n## ${f}  (${mode})`);
  console.log(`passed ${passed.length} · failed ${failed.length} · skipped ${skipped.length} · total ${runs.length}`);
  console.log(`expected-fail: ${exp.must.join(', ') || '–'} · may: ${exp.may.join(', ') || '–'}`);
  console.log(`actual-fail:   ${[...failedSet].join(', ') || '–'}`);
  console.log(`extra: ${extra.join(', ') || '–'} · missed: ${missed.join(', ') || '–'} · side-effect(accepted): ${sideOk.join(', ') || '–'} · RESULT ${ok ? 'OK' : 'MISMATCH'}`);
  for (const r of failed) console.log(`  - ${r.tc} [${r.status}] ${shortErr(r.err)}`);
  for (const r of skipped) console.log(`  - ${r.tc} [skipped]`);
  const skipParts = runs.flatMap((r) => r.annotations.filter((a) => /skip/.test(a.type)).map((a) => `${r.tc}: ${a.description}`));
  for (const s of [...new Set(skipParts)]) console.log(`  ~ ${s}`);
}
