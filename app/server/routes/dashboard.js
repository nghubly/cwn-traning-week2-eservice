'use strict';
/**
 * B10 · Dashboard ผู้บริหาร + ส่งออก Excel/PDF
 * REQUIREMENTS FR-22 FR-23 · BR-24 BR-25 BR-26 · CONTRACT §1 §2.9 §6.4 §6.8 §7 · DECISIONS §12 §18 · TEST-DATA §7 · BUGS B10
 *
 *   GET /dashboard?period=2026-11&service=ALL                  (executive · หน้า HTML)
 *   GET /api/dashboard?period=2026-11&service=ALL              (executive · JSON)
 *   GET /api/dashboard/export?format=xlsx|pdf&period=…&service=… (executive · ไฟล์ + Audit EXPORT)
 *
 * นิยาม (คิดจากแถว cases · เวลาเทียบตามนาฬิกาทดสอบ Asia/Bangkok):
 *   รับเรื่อง        = paid_at อยู่ในช่วง (รวม CANCELLED ที่เคยชำระ)
 *   ปิดงาน          = COMPLETED + REJECTED ที่ closed_at อยู่ในช่วง (CANCELLED ไม่ใช่ปิดงาน)
 *   ทัน             = ปิดงานที่ closed_at ≤ due_at (รวมวินาที 16:30:00) → rules.isOnTime
 *   ทันกำหนด %      = ทัน ÷ ปิดงาน × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น (เลขจำนวนเต็มล้วน ไม่มีปัญหาทศนิยมลอย) · ปิดงาน 0 → "–" / null
 *   งานคงค้าง       = SUBMITTED + IN_REVIEW + NEED_FIX + PENDING_APPROVAL + APPROVED ณ ตอนนี้ (ไม่ขึ้นกับช่วง · ขึ้นกับบริการ)
 *   เกินกำหนดคงค้าง = คงค้างที่ไม่ใช่ NEED_FIX และ now > due_at → rules.isOverdue
 *   งานในมือ        = IN_REVIEW ที่ owner = เจ้าหน้าที่ (role officer ทุกคน แม้ 0 · ไม่ขึ้นกับตัวกรอง)
 *   ช่วง `YYYY` = ทั้งปี ค.ศ. นั้น: รวมยอดดิบทุกเดือนก่อนแล้วคิด % (ไม่เฉลี่ย % รายเดือน · BR-26)
 *
 * BUG_MODE=B10: ตัวหารของทันกำหนด % เป็น "รับเรื่อง" แทน "ปิดงาน" (พ.ย. 23.1% · ปี 23.3% · ธ.ค. 0.0% · ต.ค. 100.0%)
 * PDPA (BR-24): หน้า/ไฟล์ส่งออกไม่อ่านคอลัมน์ผู้ยื่นเลย (ไม่มีชื่อ เลขบัตร เบอร์) · แสดงเฉพาะตัวเลขรวมและ username เจ้าหน้าที่
 *
 * ทดสอบ: `node server/routes/dashboard.js` → unit test ค่าขอบ + ตัวเลข TEST-DATA §7 ทุกแถว บน DB ชั่วคราว (exit 1 ถ้าล้ม)
 */
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const bugmode = require('../lib/bugmode');
const format = require('../lib/format');
const { html, raw } = require('../lib/html');

const SERVICE_IDS = ['SV-01', 'SV-02', 'SV-03'];
const CLOSED_STATUSES = new Set(['COMPLETED', 'REJECTED']);
const BACKLOG_STATUSES = new Set(['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED']);
const EN_DASH = '–'; // "–" ค่าทันกำหนด % เมื่อปิดงาน 0 (CONTRACT §0)
const FORMATS = ['xlsx', 'pdf'];
const MONTH_OPTIONS = 12; // เดือนย้อนหลังใน period-select (รวมเดือนปัจจุบัน)

/** ลำดับและป้ายของ 5 ช่อง (ตรงกับจอ · xlsx แถว 2–6 · CONTRACT §7) */
const KPI_FIELDS = [
  { key: 'received', testid: 'kpi-received', label: 'รับเรื่อง', pdf: 'received', en: 'Received' },
  { key: 'closed', testid: 'kpi-closed', label: 'ปิดงาน', pdf: 'closed', en: 'Closed' },
  { key: 'ontime', testid: 'kpi-ontime-pct', label: 'ทันกำหนด %', pdf: 'ontime', en: 'On-time %' },
  { key: 'backlog', testid: 'kpi-backlog', label: 'งานคงค้าง', pdf: 'backlog', en: 'Backlog (now)' },
  { key: 'overdue', testid: 'kpi-overdue', label: 'เกินกำหนดคงค้าง', pdf: 'overdue', en: 'Overdue backlog (now)' },
];

const MSG = {
  INVALID_PERIOD: 'ช่วงเวลาไม่ถูกต้อง (ใช้ YYYY-MM หรือ YYYY)',
  INVALID_SERVICE: 'บริการไม่ถูกต้อง (ใช้ ALL SV-01 SV-02 SV-03)',
  INVALID_FORMAT: 'รูปแบบไฟล์ไม่ถูกต้อง (ใช้ xlsx หรือ pdf)',
};

// ───────────────────────── ช่วงเวลา / บริการ ─────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** ช่วงตั้งต้น = เดือนของนาฬิกา (A-41) */
function defaultPeriod(now = clock.now()) {
  const p = clock.parts(now);
  return `${p.y}-${pad2(p.m)}`;
}

/** 'YYYY-MM' → {kind:'month', y, m, value} · 'YYYY' → {kind:'year', y, value} · อื่น ๆ → null */
function parsePeriod(s) {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  let m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    if (y < 1900 || y > 2999 || mo < 1 || mo > 12) return null;
    return { kind: 'month', y, m: mo, value: `${y}-${pad2(mo)}` };
  }
  m = /^(\d{4})$/.exec(v);
  if (m) {
    const y = +m[1];
    if (y < 1900 || y > 2999) return null;
    return { kind: 'year', y, value: String(y) };
  }
  return null;
}

/** เวลา ISO อยู่ในช่วงไหม (เทียบปี/เดือนตามเวลาไทย จึงไม่ขึ้นกับ offset ที่เก็บ) */
function inPeriod(iso, per) {
  if (!iso || !per) return false;
  let p;
  try { p = clock.parts(iso); } catch (e) { return false; }
  if (p.y !== per.y) return false;
  return per.kind === 'year' || p.m === per.m;
}

function serviceList(db) {
  try {
    const rows = db.prepare('SELECT id, name FROM services ORDER BY sort, id').all();
    if (rows.length) return rows.map((r) => ({ id: r.id, name: r.name || format.SERVICE_TH[r.id] || r.id }));
  } catch (e) { /* ตารางยังไม่มี → ใช้ค่าคงที่ */ }
  return SERVICE_IDS.map((id) => ({ id, name: format.SERVICE_TH[id] || id }));
}

/** 'ALL' หรือรหัสบริการที่มีจริง → ค่านั้น · ไม่ส่ง → 'ALL' · อื่น ๆ → null */
function parseService(s, db) {
  if (s === undefined || s === null || s === '') return 'ALL';
  const v = String(s).trim().toUpperCase();
  if (v === 'ALL') return 'ALL';
  const ids = db ? serviceList(db).map((x) => x.id) : SERVICE_IDS;
  return ids.includes(v) ? v : null;
}

// ───────────────────────── ตัวเลข ─────────────────────────

/** ร้อยละ ×10 ปัดครึ่งขึ้นด้วยเลขจำนวนเต็ม (6/7 → 857 · 2/3 → 667 · 7/8 → 875) · ตัวหาร 0 → null */
function pct10(num, den) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isInteger(n) || !Number.isInteger(d) || d <= 0 || n < 0) return null;
  return Math.floor((2 * n * 1000 + d) / (2 * d));
}

/** ข้อความบนจอ/xlsx: 857 → "85.7%" · null → "–" */
function formatPct(p10) {
  if (p10 === null || p10 === undefined) return EN_DASH;
  return `${Math.floor(p10 / 10)}.${p10 % 10}%`;
}

/**
 * คำนวณ Dashboard ทั้งชุด (ฟังก์ชันเดียวที่จอ · API · ไฟล์ส่งออกใช้ร่วมกัน จึงเท่ากันทุกช่อง)
 * @param db better-sqlite3
 * @param {object} o {period:'2026-11'|'2026'|parsed, service:'ALL'|'SV-0x', now?, bugB10?}
 */
function computeDashboard(db, o = {}) {
  const now = o.now === undefined || o.now === null ? clock.now() : o.now;
  const per = (o.period && typeof o.period === 'object') ? o.period : parsePeriod(o.period || defaultPeriod(now));
  if (!per) throw Object.assign(new Error(MSG.INVALID_PERIOD), { status: 400, code: 'INVALID_PERIOD', expose: true });
  const service = o.service || 'ALL';
  const bugB10 = o.bugB10 === undefined ? bugmode.isBug('B10') : !!o.bugB10;

  // อ่านเฉพาะคอลัมน์ที่ใช้คำนวณ (ไม่แตะ user_id/ข้อมูลผู้ยื่น · BR-24)
  const rows = service === 'ALL'
    ? db.prepare('SELECT status, paid_at, created_at, due_at, closed_at FROM cases').all()
    : db.prepare('SELECT status, paid_at, created_at, due_at, closed_at FROM cases WHERE service_id = ?').all(service);

  let received = 0;
  let closed = 0;
  let onTime = 0;
  let backlog = 0;
  let overdue = 0;
  for (const c of rows) {
    if (inPeriod(c.paid_at || c.created_at, per)) received++;
    if (CLOSED_STATUSES.has(c.status) && inPeriod(c.closed_at, per)) {
      closed++;
      if (c.due_at && rules.isOnTime(c.closed_at, c.due_at)) onTime++;
    }
    if (BACKLOG_STATUSES.has(c.status)) {
      backlog++;
      if (c.status !== 'NEED_FIX' && c.due_at && rules.isOverdue(now, c.due_at)) overdue++;
    }
  }

  // B10: หารด้วยรับเรื่องแทนปิดงาน (BUGS.md)
  const p10 = pct10(onTime, bugB10 ? received : closed);

  return {
    period: per.value,
    periodKind: per.kind,
    service,
    asOf: clock.toIso(now),
    received,
    closed,
    onTime,
    ontimePct: p10 === null ? null : p10 / 10,
    ontimeText: formatPct(p10),
    backlog,
    overdue,
    workload: computeWorkload(db),
  };
}

/** งานในมือ (IN_REVIEW) ของเจ้าหน้าที่ทุกคน แม้ 0 · ไม่ขึ้นกับตัวกรอง (A-41) */
function computeWorkload(db) {
  const officers = db.prepare("SELECT username, name, dept FROM users WHERE role = 'officer' AND active = 1 AND username IS NOT NULL ORDER BY username").all();
  const counts = new Map(
    db.prepare("SELECT owner, COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner IS NOT NULL GROUP BY owner").all()
      .map((r) => [r.owner, r.n]),
  );
  return officers.map((u) => ({ username: u.username, name: u.name || u.username, dept: u.dept || '', count: counts.get(u.username) || 0 }));
}

/** ค่าที่แสดงบนจอเป็นข้อความ เรียงตาม KPI_FIELDS (ใช้ทั้งจอ · xlsx · pdf) */
function kpiTexts(d) {
  return {
    received: String(d.received),
    closed: String(d.closed),
    ontime: d.ontimeText,
    backlog: String(d.backlog),
    overdue: String(d.overdue),
  };
}

/** JSON ของ GET /api/dashboard (CONTRACT §6.4) */
function apiShape(d) {
  return {
    period: d.period,
    service: d.service,
    received: d.received,
    closed: d.closed,
    onTime: d.onTime,
    ontimePct: d.ontimePct,
    backlog: d.backlog,
    overdue: d.overdue,
    workload: d.workload.map((w) => ({ username: w.username, count: w.count })),
  };
}

// ───────────────────────── ป้ายภาษาไทย ─────────────────────────

function periodLabel(per) {
  if (!per) return '';
  if (per.kind === 'year') return `ทั้งปี ${per.y + 543}`;
  return `${clock.TH_MONTHS[per.m - 1]} ${per.y + 543}`;
}

function serviceLabel(service, services) {
  if (service === 'ALL') return 'ทุกบริการ';
  const s = services.find((x) => x.id === service);
  return s ? `${s.id} ${s.name}` : service;
}

/** ตัวเลือกของ period-select: 12 เดือนล่าสุด (ใหม่ → เก่า) + ทั้งปีปัจจุบัน/ปีก่อน · ค่าที่เลือกอยู่ถ้าไม่อยู่ในรายการจะถูกเพิ่ม */
function periodOptions(now, selected) {
  const p = clock.parts(now);
  const months = [];
  let y = p.y;
  let m = p.m;
  for (let i = 0; i < MONTH_OPTIONS; i++) {
    months.push(parsePeriod(`${y}-${pad2(m)}`));
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  const years = [parsePeriod(String(p.y)), parsePeriod(String(p.y - 1))];
  if (selected && ![...months, ...years].some((x) => x.value === selected.value)) {
    (selected.kind === 'year' ? years : months).push(selected);
    months.sort((a, b) => (b.value > a.value ? 1 : -1));
    years.sort((a, b) => b.y - a.y);
  }
  return { months, years };
}

// ───────────────────────── หน้า HTML ─────────────────────────

const PAGE_CSS = `
.dash-sub{color:#4b5563;margin:.25rem 0 1rem}
.dash-filters{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end;margin:0 0 1.5rem}
.dash-filters label{margin-top:0}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr));gap:1rem;margin:0 0 1.5rem;padding:0}
.kpi{background:#fff;border:1px solid #d0d4da;border-radius:8px;padding:.875rem 1rem}
.kpi dt{font-weight:600;color:#374151}
.kpi dd{margin:0}
.kpi .kpi-value{font-size:2rem;font-weight:600;line-height:1.25;color:#1a1a1a}
.kpi .kpi-note{font-size:.875rem;color:#4b5563}
.dash-section{margin:0 0 1.5rem}
.dash-section h2{font-size:1.15rem;margin:0 0 .5rem}
.dash-table{background:#fff}
.dash-table th.num,.dash-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.dash-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:.5rem 0}
.dash-actions a.btn{display:inline-block;text-decoration:none}
`;

function kpiTile(f, value, note) {
  return html`<div class="kpi"><dt>${f.label}</dt><dd class="kpi-value" data-testid="${f.testid}">${value}</dd><dd class="kpi-note">${note}</dd></div>`;
}

function exportHref(fmt, d) {
  return `/api/dashboard/export?format=${encodeURIComponent(fmt)}&period=${encodeURIComponent(d.period)}&service=${encodeURIComponent(d.service)}`;
}

/** เนื้อหน้า /dashboard (ไม่รวม header ของ layout) */
function renderBody(d, ctxView) {
  const { now, services } = ctxView;
  const per = parsePeriod(d.period);
  const t = kpiTexts(d);
  const opts = periodOptions(now, per);
  const asOf = clock.toIso(now);
  const opt = (value, label, sel) => html`<option value="${value}"${raw(sel ? ' selected' : '')}>${label}</option>`;
  const notes = {
    received: 'ชำระสำเร็จในช่วงที่เลือก (รวมที่ยกเลิกภายหลัง)',
    closed: 'เสร็จสิ้น + ไม่อนุมัติ ในช่วงที่เลือก',
    ontime: `ทัน ${d.onTime} เรื่อง (ปิดไม่เกินกำหนดเสร็จ 16:30 น.)`,
    backlog: 'ณ ตอนนี้ · ไม่ขึ้นกับช่วงที่เลือก',
    overdue: 'ณ ตอนนี้ · ไม่นับรอแก้ไขเอกสาร',
  };

  return html`<style>${raw(PAGE_CSS)}</style>
<h1>Dashboard ภาพรวมการให้บริการ</h1>
<p class="dash-sub">ข้อมูล ณ <time datetime="${asOf}" data-iso="${asOf}">${clock.formatThai(now)}</time> น. · แสดงเฉพาะตัวเลขรวม ไม่มีข้อมูลส่วนบุคคลของผู้ยื่น</p>
<form class="dash-filters" method="get" action="/dashboard" aria-label="ตัวกรอง Dashboard">
  <div>
    <label for="period-select">ช่วงเวลา</label>
    <select id="period-select" name="period" data-testid="period-select" onchange="this.form.submit()">
      <optgroup label="รายเดือน">${opts.months.map((x) => opt(x.value, periodLabel(x), x.value === d.period))}</optgroup>
      <optgroup label="รายปี (รวมทุกเดือน)">${opts.years.map((x) => opt(x.value, periodLabel(x), x.value === d.period))}</optgroup>
    </select>
  </div>
  <div>
    <label for="service-select">บริการ</label>
    <select id="service-select" name="service" data-testid="service-select" onchange="this.form.submit()">
      ${opt('ALL', 'ทุกบริการ', d.service === 'ALL')}${services.map((s) => opt(s.id, `${s.id} ${s.name}`, d.service === s.id))}
    </select>
  </div>
  <noscript><button type="submit">แสดงผล</button></noscript>
</form>
<section class="dash-section" aria-labelledby="kpi-heading">
  <h2 id="kpi-heading">ตัวชี้วัด · ${periodLabel(per)} · ${serviceLabel(d.service, services)}</h2>
  <dl class="kpi-row">${KPI_FIELDS.map((f) => kpiTile(f, t[f.key], notes[f.key]))}</dl>
</section>
<section class="dash-section" aria-labelledby="workload-heading">
  <h2 id="workload-heading">งานในมือรายเจ้าหน้าที่</h2>
  <p class="dash-sub">คำขอสถานะ “กำลังตรวจสอบ” ที่แต่ละคนรับไว้ ณ ตอนนี้ (ไม่ขึ้นกับตัวกรอง)</p>
  <div class="table-wrap"><table class="dash-table">
    <thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">ชื่อผู้ใช้</th><th scope="col" class="num">งานในมือ (เรื่อง)</th></tr></thead>
    <tbody>${d.workload.map((w) => html`<tr data-testid="workload-row" data-username="${w.username}"><td>${w.name}</td><td>${w.username}</td><td class="num" data-testid="workload-value">${String(w.count)}</td></tr>`)}</tbody>
  </table></div>
</section>
<section class="dash-section" aria-labelledby="export-heading">
  <h2 id="export-heading">ส่งออกรายงาน</h2>
  <div class="dash-actions">
    <a class="btn" data-testid="export-xlsx-btn" href="${exportHref('xlsx', d)}" download>ส่งออก Excel</a>
    <a class="btn" data-testid="export-pdf-btn" href="${exportHref('pdf', d)}" download>ส่งออก PDF</a>
  </div>
  <p class="dash-sub">ไฟล์มีตัวเลขเท่ากับบนจอทุกช่อง (${periodLabel(per)} · ${serviceLabel(d.service, services)}) และการส่งออกทุกครั้งถูกบันทึกใน Audit Trail</p>
</section>`;
}

// ───────────────────────── ไฟล์ส่งออก (CONTRACT §7) ─────────────────────────

function exportFileName(d, fmt) {
  return `dashboard-${d.period}-${d.service}.${fmt}`;
}

/** .xlsx: ชีตแรก A1 "ตัวชี้วัด" B1 "ค่า" · แถว 2–6 ป้าย + ค่าตามจอเป็นข้อความ · ชีตที่ 2 = เงื่อนไข + งานในมือ */
async function buildXlsx(d, services = serviceList(null)) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'e-Service เทศบาลนครสุขใจ (ระบบจำลอง)';
  wb.created = clock.parseIso(d.asOf) || clock.now();
  wb.modified = wb.created;
  const t = kpiTexts(d);

  const ws = wb.addWorksheet('Dashboard');
  ws.columns = [{ width: 22 }, { width: 14 }];
  const head = ws.addRow(['ตัวชี้วัด', 'ค่า']);
  head.font = { bold: true };
  for (const f of KPI_FIELDS) {
    const r = ws.addRow([f.label, t[f.key]]);
    r.getCell(2).numFmt = '@'; // ข้อความตามจอ (ไม่ให้ Excel แปลงเป็นตัวเลข)
    r.getCell(2).alignment = { horizontal: 'right' };
  }

  const info = wb.addWorksheet('รายละเอียด');
  info.columns = [{ width: 26 }, { width: 34 }];
  info.addRow(['รายการ', 'ค่า']).font = { bold: true };
  info.addRow(['ช่วงเวลา', `${periodLabel(parsePeriod(d.period))} (${d.period})`]);
  info.addRow(['บริการ', serviceLabel(d.service, services)]);
  info.addRow(['ข้อมูล ณ', `${clock.formatThai(d.asOf)} น.`]);
  info.addRow(['ปิดงานที่ทันกำหนด', String(d.onTime)]);
  info.addRow([]);
  info.addRow(['งานในมือ (ชื่อผู้ใช้)', 'กำลังตรวจสอบ (เรื่อง)']).font = { bold: true };
  for (const w of d.workload) info.addRow([w.username, String(w.count)]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** สตริง PDF literal (ASCII เท่านั้น) */
function pdfStr(s) {
  return `(${String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')})`;
}

/** บรรทัดข้อความใน PDF (ASCII · บรรทัด kpi เครื่องอ่านได้ตาม CONTRACT §7 · ปิดงาน 0 → ontime=-) */
function pdfLines(d) {
  const t = kpiTexts(d);
  const ontimeAscii = d.ontimePct === null ? '-' : t.ontime;
  const lines = [
    'e-Service Dashboard - Sukjai City Municipality (fictional test system)',
    `period=${d.period} service=${d.service} asof=${d.asOf}`,
    '',
    `kpi received=${t.received} closed=${t.closed} ontime=${ontimeAscii} backlog=${t.backlog} overdue=${t.overdue}`,
    '',
  ];
  for (const f of KPI_FIELDS) lines.push(`${f.en}: ${f.key === 'ontime' ? ontimeAscii : t[f.key]}`);
  lines.push(`On-time closed cases: ${d.onTime}`);
  lines.push('');
  lines.push('Workload (IN_REVIEW per officer, now):');
  for (const w of d.workload) lines.push(`  ${w.username}: ${w.count}`);
  lines.push('');
  lines.push('No applicant personal data is included in this report.');
  return lines;
}

/** PDF 1.4 หน้าเดียว (Helvetica · content stream ไม่บีบอัด) · คำนวณตำแหน่ง xref เป็นไบต์จริง */
function buildPdf(d) {
  const lines = pdfLines(d);
  const ops = ['BT', '/F1 12 Tf', '16 TL', '50 790 Td'];
  lines.forEach((l, i) => { if (i) ops.push('T*'); if (l) ops.push(`${pdfStr(l)} Tj`); });
  ops.push('ET');
  const content = `${ops.join('\n')}\n`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    `<< /Title ${pdfStr(`Dashboard ${d.period} ${d.service}`)} /Producer (e-Service test system) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ───────────────────────── routes ─────────────────────────

function register(app, ctx) {
  const auth = require('./auth'); // lazy: self-test ไม่ต้องโหลด auth/DB หลัก
  const db = (ctx && ctx.db) || require('../db').db;
  const isB10 = () => (ctx && typeof ctx.isBug === 'function' ? ctx.isBug('B10') : bugmode.isBug('B10'));

  /** อ่าน query → {period, service} หรือ {error} */
  function readQuery(q, strict) {
    const now = clock.now();
    let per = q.period === undefined || q.period === '' ? parsePeriod(defaultPeriod(now)) : parsePeriod(String(q.period));
    let service = parseService(q.service, db);
    if (strict) {
      if (!per) return { error: ['INVALID_PERIOD', MSG.INVALID_PERIOD] };
      if (!service) return { error: ['INVALID_SERVICE', MSG.INVALID_SERVICE] };
    }
    if (!per) per = parsePeriod(defaultPeriod(now));
    if (!service) service = 'ALL';
    return { now, per, service };
  }

  app.get('/dashboard', auth.requirePage('executive'), (req, res, next) => {
    try {
      const q = readQuery(req.query, false);
      const d = computeDashboard(db, { period: q.per, service: q.service, now: q.now, bugB10: isB10() });
      const body = renderBody(d, { now: q.now, services: serviceList(db) });
      return auth.sendPage(req, res, { title: 'Dashboard', body });
    } catch (e) { return next(e); }
  });

  app.get('/api/dashboard', auth.requireApi('executive'), (req, res, next) => {
    try {
      const q = readQuery(req.query, true);
      if (q.error) return auth.apiError(res, 400, q.error[0], q.error[1]);
      const d = computeDashboard(db, { period: q.per, service: q.service, now: q.now, bugB10: isB10() });
      return res.json(apiShape(d));
    } catch (e) { return next(e); }
  });

  app.get('/api/dashboard/export', auth.requireApi('executive'), async (req, res, next) => {
    try {
      const fmt = String(req.query.format || '').trim().toLowerCase();
      if (!FORMATS.includes(fmt)) return auth.apiError(res, 400, 'INVALID_FORMAT', MSG.INVALID_FORMAT);
      const q = readQuery(req.query, true);
      if (q.error) return auth.apiError(res, 400, q.error[0], q.error[1]);
      const d = computeDashboard(db, { period: q.per, service: q.service, now: q.now, bugB10: isB10() });
      const buf = fmt === 'xlsx' ? await buildXlsx(d, serviceList(db)) : buildPdf(d);
      // Audit EXPORT 1 แถวต่อการส่งออก 1 ครั้ง (CONTRACT §6.8: "<format> <period> <service>")
      if (req.method !== 'HEAD') auth.auditFor(req.user, 'EXPORT', { detail: `${fmt} ${d.period} ${d.service}` });
      res.status(200);
      res.set('Content-Type', fmt === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${exportFileName(d, fmt)}"`);
      res.set('Content-Length', String(buf.length));
      return res.end(buf);
    } catch (e) { return next(e); }
  });
}

module.exports = register;
Object.assign(module.exports, {
  register, computeDashboard, computeWorkload, apiShape, kpiTexts, renderBody, buildXlsx, buildPdf, pdfLines,
  parsePeriod, parseService, inPeriod, defaultPeriod, pct10, formatPct, periodOptions, KPI_FIELDS, EN_DASH,
});

// ───────────────────────── self-test: node server/routes/dashboard.js ─────────────────────────

async function selfTest() {
  const assert = require('assert');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b10-dash-'));
  process.env.DB_PATH = path.join(tmp, 'egov.db');
  process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

  let pass = 0;
  let fail = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
  };
  const PII_13 = /\d{13}/;
  const PII_TEL = /0\d{9}/;
  const NAMES = ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ'];
  const noPII = (text, label) => {
    assert.ok(!PII_13.test(text), `${label}: พบเลข 13 หลัก`);
    assert.ok(!PII_TEL.test(text), `${label}: พบเบอร์ 0\\d{9}`);
    for (const n of NAMES) assert.ok(!text.includes(n), `${label}: พบชื่อ ${n}`);
  };

  console.log('B10 dashboard self-test');
  console.log('-- ฟังก์ชันล้วน');
  await t('pct10 ปัดครึ่งขึ้น (6/7 · 2/3 · 7/8 · 1/16 · 1/8 · 1/1 · 0/1)', () => {
    assert.deepStrictEqual([pct10(6, 7), pct10(2, 3), pct10(7, 8), pct10(1, 16), pct10(1, 8), pct10(1, 1), pct10(0, 1)],
      [857, 667, 875, 63, 125, 1000, 0]);
    assert.strictEqual(pct10(1, 3), 333); // 33.33 → 33.3
    assert.strictEqual(pct10(1, 6), 167); // 16.666 → 16.7
    assert.strictEqual(pct10(1, 40), 25); // 2.5 ตรง
    assert.strictEqual(pct10(1, 80), 13); // 1.25 → 1.3 (ครึ่งขึ้น)
    assert.strictEqual(pct10(3, 80), 38); // 3.75 → 3.8
  });
  await t('ตัวหาร 0 → null → "–" (ห้าม NaN/0%)', () => {
    assert.strictEqual(pct10(0, 0), null);
    assert.strictEqual(formatPct(null), '–');
    assert.strictEqual(formatPct(pct10(0, 0)), '–');
  });
  await t('formatPct 857 → 85.7% · 1000 → 100.0% · 0 → 0.0% · 5 → 0.5%', () => {
    assert.deepStrictEqual([formatPct(857), formatPct(1000), formatPct(0), formatPct(5)], ['85.7%', '100.0%', '0.0%', '0.5%']);
    assert.strictEqual(pct10(6, 7) / 10, 85.7);
    assert.strictEqual(pct10(2, 3) / 10, 66.7);
  });
  await t('B10 ค่าผิดตาม BUGS (6/26 · 7/30 · 0/3 · 1/1)', () => {
    assert.deepStrictEqual([pct10(6, 26), pct10(7, 30), pct10(0, 3), pct10(1, 1)].map(formatPct), ['23.1%', '23.3%', '0.0%', '100.0%']);
  });
  await t('parsePeriod: 2026-12 · 2026 ✓ · 2026-13 · 26-1 · 2026-1 · "" ✗', () => {
    assert.deepStrictEqual(parsePeriod('2026-12'), { kind: 'month', y: 2026, m: 12, value: '2026-12' });
    assert.deepStrictEqual(parsePeriod('2026'), { kind: 'year', y: 2026, value: '2026' });
    for (const bad of ['2026-13', '2026-00', '26-1', '2026-1', '', 'ALL', '2569x', null, undefined]) assert.strictEqual(parsePeriod(bad), null, String(bad));
  });
  await t('inPeriod ขอบเดือนตามเวลาไทย (23:59:59 / 00:00:00 / offset Z)', () => {
    const nov = parsePeriod('2026-11');
    const dec = parsePeriod('2026-12');
    assert.strictEqual(inPeriod('2026-11-30T23:59:59+07:00', nov), true);
    assert.strictEqual(inPeriod('2026-12-01T00:00:00+07:00', nov), false);
    assert.strictEqual(inPeriod('2026-12-01T00:00:00+07:00', dec), true);
    assert.strictEqual(inPeriod('2026-11-30T17:00:00Z', dec), true); // = 1 ธ.ค. 00:00 ไทย
    assert.strictEqual(inPeriod('2026-11-30T16:59:59Z', nov), true);
    assert.strictEqual(inPeriod('2026-12-31T23:59:59+07:00', parsePeriod('2026')), true);
    assert.strictEqual(inPeriod('2027-01-01T00:00:00+07:00', parsePeriod('2026')), false);
    assert.strictEqual(inPeriod(null, nov), false);
  });
  await t('ค่าขอบ "ทัน" ที่ rules.isOnTime (16:29:59 ✓ · 16:30:00 ✓ · 16:30:01 ✗ · 16:31 ✗)', () => {
    const due = '2026-12-03T16:30:00+07:00';
    assert.deepStrictEqual(['16:29:59', '16:30:00', '16:30:01', '16:31:00'].map((x) => rules.isOnTime(`2026-12-03T${x}+07:00`, due)),
      [true, true, false, false]);
  });
  await t('parseService: ALL/SV-01..03/ว่าง ✓ · SV-04 ✗', () => {
    assert.deepStrictEqual(['ALL', 'SV-01', 'sv-02', 'SV-03', undefined, ''].map((s) => parseService(s)), ['ALL', 'SV-01', 'SV-02', 'SV-03', 'ALL', 'ALL']);
    assert.strictEqual(parseService('SV-04'), null);
  });
  await t('period-select มี 2026-12 2026-11 2026-10 2026 (นาฬิกา 1 ธ.ค. 2569)', () => {
    const o = periodOptions('2026-12-01T09:00:00+07:00', parsePeriod('2026-12'));
    const vals = [...o.months, ...o.years].map((x) => x.value);
    for (const v of ['2026-12', '2026-11', '2026-10', '2026']) assert.ok(vals.includes(v), v);
    assert.strictEqual(o.months[0].value, '2026-12');
    const o2 = periodOptions('2026-12-01T09:00:00+07:00', parsePeriod('2020-05'));
    assert.ok(o2.months.some((x) => x.value === '2020-05'));
  });

  console.log('-- บน seed (TEST-DATA §7) · DB ชั่วคราว', tmp);
  const dbm = require('../db');
  const { resetAll } = require('../lib/reset');
  resetAll();
  const db = dbm.db;
  const T0 = '2026-12-01T09:00:00+07:00';
  const D = (period, service = 'ALL', extra = {}) => computeDashboard(db, { period, service, now: T0, bugB10: false, ...extra });
  const row = (d) => [d.received, d.closed, d.ontimeText, d.backlog, d.overdue];

  await t('7.1 ธ.ค./ALL: 3 · 0 · – · 21 · 1 · ontimePct null', () => {
    const d = D('2026-12');
    assert.deepStrictEqual(row(d), [3, 0, '–', 21, 1]);
    assert.strictEqual(d.ontimePct, null);
  });
  await t('7.1 งานในมือ off.reg1 3 · off.reg2 9 · off.works1 0 (3 แถว)', () => {
    assert.deepStrictEqual(D('2026-12').workload.map((w) => [w.username, w.count]), [['off.reg1', 3], ['off.reg2', 9], ['off.works1', 0]]);
  });
  for (const [svc, exp] of [['SV-01', [3, 0, '–', 11, 1]], ['SV-02', [0, 0, '–', 7, 0]], ['SV-03', [0, 0, '–', 3, 0]]]) {
    await t(`7.2 ธ.ค./${svc}: ${exp.join(' · ')}`, () => assert.deepStrictEqual(row(D('2026-12', svc)), exp));
  }
  const NOWV = { ALL: [21, 1], 'SV-01': [11, 1], 'SV-02': [7, 0], 'SV-03': [3, 0] };
  const HIST = [
    ['2026-10', 'ALL', 1, 1, 1, '100.0%'],
    ['2026-11', 'ALL', 26, 7, 6, '85.7%'],
    ['2026-11', 'SV-01', 12, 3, 3, '100.0%'],
    ['2026-11', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026-11', 'SV-03', 4, 1, 1, '100.0%'],
    ['2026', 'ALL', 30, 8, 7, '87.5%'],
    ['2026', 'SV-01', 16, 4, 4, '100.0%'],
    ['2026', 'SV-02', 10, 3, 2, '66.7%'],
    ['2026', 'SV-03', 4, 1, 1, '100.0%'],
  ];
  for (const [per, svc, rec, cl, on, pct] of HIST) {
    await t(`7.3 ${per}/${svc}: รับ ${rec} · ปิด ${cl} · ทัน ${on} · ${pct} · คงค้าง/เกิน ${NOWV[svc].join('/')}`, () => {
      const d = D(per, svc);
      assert.deepStrictEqual([d.received, d.closed, d.onTime, d.ontimeText, d.backlog, d.overdue], [rec, cl, on, pct, ...NOWV[svc]]);
      assert.strictEqual(d.ontimePct, Number(pct.replace('%', '')));
    });
  }
  await t('ปี 2569 รวมยอดก่อนคิด % = 87.5% (ไม่ใช่เฉลี่ย 92.9%)', () => {
    const y = D('2026');
    const avg = Math.round(((D('2026-10').ontimePct + D('2026-11').ontimePct) / 2) * 10) / 10;
    assert.strictEqual(y.ontimeText, '87.5%');
    assert.strictEqual(avg, 92.9);
  });
  await t('ปีที่ไม่มีข้อมูล (2025) → 0 · 0 · –', () => assert.deepStrictEqual(row(D('2025')).slice(0, 3), [0, 0, '–']));

  console.log('-- BUG_MODE B10 (ตัวหาร = รับเรื่อง)');
  for (const [per, svc, exp] of [['2026-11', 'ALL', '23.1%'], ['2026', 'ALL', '23.3%'], ['2026-12', 'ALL', '0.0%'], ['2026-10', 'ALL', '100.0%'], ['2026-12', 'SV-02', '–']]) {
    await t(`B10 ${per}/${svc} → ${exp}`, () => assert.strictEqual(D(per, svc, { bugB10: true }).ontimeText, exp));
  }
  await t('B10 ไม่เปิด (ค่าเริ่มต้นของโปรเซสนี้) → พ.ย. 85.7%', () => {
    if (bugmode.isBug('B10')) return; // ถ้ารันพร้อม BUG_MODE=B10 ข้ามข้อนี้
    assert.strictEqual(computeDashboard(db, { period: '2026-11', service: 'ALL', now: T0 }).ontimeText, '85.7%');
  });

  console.log('-- ค่าขอบเกินกำหนดคงค้าง (now > due_at)');
  await t('…000020 กำหนด 30 พ.ย. 16:30: now 16:30:00 ไม่เกิน · 16:30:01 เกิน', () => {
    const due = db.prepare('SELECT due_at FROM cases WHERE case_no = ?').get('EG-2569-000020').due_at;
    assert.strictEqual(due, '2026-11-30T16:30:00+07:00');
    assert.strictEqual(computeDashboard(db, { period: '2026-11', now: '2026-11-30T16:30:00+07:00', bugB10: false }).overdue, 0);
    assert.strictEqual(computeDashboard(db, { period: '2026-11', now: '2026-11-30T16:30:01+07:00', bugB10: false }).overdue, 1);
  });

  console.log('-- ไฟล์ส่งออก + หน้า (PDPA)');
  const services = serviceList(db);
  await t('xlsx พ.ย./ALL: หัว ตัวชี้วัด/ค่า · 26 7 85.7% 21 1 · ไม่มี PII', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildXlsx(D('2026-11'), services));
    const ws = wb.worksheets[0];
    const cell = (r, c) => String(ws.getRow(r).getCell(c).value);
    assert.deepStrictEqual([cell(1, 1), cell(1, 2)], ['ตัวชี้วัด', 'ค่า']);
    assert.deepStrictEqual([2, 3, 4, 5, 6].map((r) => cell(r, 1)), ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง']);
    assert.deepStrictEqual([2, 3, 4, 5, 6].map((r) => ws.getRow(r).getCell(2).value), ['26', '7', '85.7%', '21', '1']);
    const all = [];
    wb.eachSheet((s) => s.eachRow((r) => all.push((r.values || []).map((v) => (v == null ? '' : String(v))).join('\t'))));
    noPII(all.join('\n'), 'xlsx');
  });
  await t('xlsx ธ.ค./ALL: 3 0 – 21 1', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildXlsx(D('2026-12'), services));
    assert.deepStrictEqual([2, 3, 4, 5, 6].map((r) => wb.worksheets[0].getRow(r).getCell(2).value), ['3', '0', '–', '21', '1']);
  });
  await t('pdf พ.ย.: %PDF · บรรทัด kpi ตรงตัว · xref ชี้ object ถูก · ไม่มี PII', () => {
    const buf = buildPdf(D('2026-11'));
    const s = buf.toString('latin1');
    assert.strictEqual(s.slice(0, 5), '%PDF-');
    assert.ok(s.includes('(kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1) Tj'));
    const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]);
    assert.strictEqual(s.slice(xrefAt, xrefAt + 4), 'xref');
    const offs = [...s.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offs.forEach((o, i) => assert.strictEqual(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
    const len = Number(/\/Length (\d+) >>\nstream\n/.exec(s)[1]);
    const st = s.indexOf('stream\n') + 7;
    assert.strictEqual(s.slice(st + len, st + len + 9), 'endstream');
    noPII(pdfLines(D('2026-11')).join('\n'), 'pdf');
  });
  await t('pdf ธ.ค. (ปิดงาน 0) → ontime=-', () => {
    assert.ok(buildPdf(D('2026-12')).toString('latin1').includes('kpi received=3 closed=0 ontime=- backlog=21 overdue=1'));
  });
  await t('หน้า /dashboard: testid ครบ · ค่าตรง · ไม่มี PII ในข้อความ', () => {
    const page = String(renderBody(D('2026-11'), { now: T0, services }));
    for (const id of ['period-select', 'service-select', 'kpi-received', 'kpi-closed', 'kpi-ontime-pct', 'kpi-backlog', 'kpi-overdue', 'export-xlsx-btn', 'export-pdf-btn']) {
      assert.ok(page.includes(`data-testid="${id}"`), id);
    }
    assert.strictEqual((page.match(/data-testid="workload-row"/g) || []).length, 3);
    assert.ok(page.includes('data-testid="kpi-ontime-pct">85.7%</dd>'));
    assert.ok(page.includes('<option value="2026-11" selected>'));
    assert.ok(page.includes('href="/api/dashboard/export?format=xlsx&amp;period=2026-11&amp;service=ALL"'));
    const text = page.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, '\n');
    noPII(text, 'page');
  });
  await t('API shape ตาม CONTRACT §6.4 (ธ.ค./ALL)', () => {
    const a = apiShape(D('2026-12'));
    assert.deepStrictEqual(
      { received: a.received, closed: a.closed, onTime: a.onTime, ontimePct: a.ontimePct, backlog: a.backlog, overdue: a.overdue },
      { received: 3, closed: 0, onTime: 0, ontimePct: null, backlog: 21, overdue: 1 },
    );
    assert.deepStrictEqual(a.workload, [{ username: 'off.reg1', count: 3 }, { username: 'off.reg2', count: 9 }, { username: 'off.works1', count: 0 }]);
    noPII(JSON.stringify(a), 'api');
  });

  console.log('-- TC-DASH-04 ค่าขอบ "ทัน" (กำหนด 3 ธ.ค. 16:30 · ปรับแถวตรงใน DB ชั่วคราว)');
  const close = (n, status, at) => db.prepare("UPDATE cases SET status = ?, closed_at = ?, owner = NULL, dept = NULL WHERE case_no = ?")
    .run(status, at, `EG-2569-0000${n}`);
  const NOW3 = '2026-12-03T16:30:01+07:00';
  await t('…000023/25/26 กำหนดเสร็จ 2026-12-03T16:30:00+07:00', () => {
    for (const n of [23, 25, 26]) assert.strictEqual(db.prepare('SELECT due_at FROM cases WHERE case_no = ?').get(`EG-2569-0000${n}`).due_at, '2026-12-03T16:30:00+07:00');
  });
  await t('16:29:59 COMPLETED …000025 → ปิด 1 ทัน 1', () => {
    close(25, 'COMPLETED', '2026-12-03T16:29:59+07:00');
    const d = computeDashboard(db, { period: '2026-12', now: '2026-12-03T16:29:59+07:00', bugB10: false });
    assert.deepStrictEqual([d.closed, d.onTime, d.backlog], [1, 1, 20]);
  });
  await t('16:30:00 REJECTED …000026 → ปิด 2 ทัน 2 (ที่ขอบ · REJECTED นับ)', () => {
    close(26, 'REJECTED', '2026-12-03T16:30:00+07:00');
    const d = computeDashboard(db, { period: '2026-12', now: '2026-12-03T16:30:00+07:00', bugB10: false });
    assert.deepStrictEqual([d.closed, d.onTime, d.backlog], [2, 2, 19]);
  });
  await t('16:30:01 COMPLETED …000023 → ปิด 3 ทัน 2 · คงค้าง 18 · 66.7%', () => {
    close(23, 'COMPLETED', NOW3);
    const d = computeDashboard(db, { period: '2026-12', now: NOW3, bugB10: false });
    assert.deepStrictEqual([d.closed, d.onTime, d.backlog, d.ontimeText], [3, 2, 18, '66.7%']);
    assert.strictEqual(d.workload.find((w) => w.username === 'off.reg1').count, 2);
  });
  await t('ปิด 16:31:00 → ไม่ทัน · CANCELLED ไม่นับเป็นปิดงาน', () => {
    close(23, 'COMPLETED', '2026-12-03T16:31:00+07:00');
    assert.strictEqual(computeDashboard(db, { period: '2026-12', now: NOW3, bugB10: false }).onTime, 2);
    db.prepare("UPDATE cases SET status = 'CANCELLED', cancelled_at = ? WHERE case_no = 'EG-2569-000028'").run(NOW3);
    const d = computeDashboard(db, { period: '2026-12', now: NOW3, bugB10: false });
    assert.deepStrictEqual([d.received, d.closed, d.backlog], [3, 3, 17]);
  });

  try { dbm.db.close(); } catch (e) { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (require.main === module) {
  selfTest().catch((e) => { console.error(e); process.exit(1); });
}
