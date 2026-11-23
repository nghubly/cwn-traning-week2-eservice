'use strict';
/**
 * กฎตัวเลข (B04): ค่าธรรมเนียม · SLA วันทำการ · หยุดนับ NEED_FIX · ระดับเตือน
 * ที่มา: REQUIREMENTS BR-04 BR-05 BR-12 BR-13 BR-14 · DECISIONS §0 §3 §8 §18 · BUGS B01 B03 B04
 *
 * ทุกฟังก์ชันไม่มี side effect (อ่าน DB อย่างเดียว) · เวลาเข้าเป็น ISO มี offset / Date / ms
 * เวลาออกเป็น ISO "+07:00" เสมอ · ไม่เรียกเวลาเครื่อง (ค่า now ตั้งต้นมาจาก lib/clock = นาฬิกาทดสอบ)
 *
 * แหล่งวันหยุด (`hol`) ส่งได้หลายแบบ: better-sqlite3 db · {db} (ctx/dbm) · Set/Array ของ 'YYYY-MM-DD'
 * ไม่ส่ง = อ่านตาราง holidays จาก DB หลัก (`require('../db').db`) ทุกครั้งที่เรียก (ค่าล่าสุดเสมอ)
 * ถ้าวนหลายแถว ให้โหลดครั้งเดียวด้วย loadHolidays(db) แล้วส่ง Set ต่อ
 *
 * API หลัก
 *   calcFee(service, {qty, areaSqm}, db?)  → {ok:true, fee, qty?, areaSqm?}
 *                                         | {ok:false, status:400, code, message}  (code: INVALID_QTY INVALID_AREA AREA_TOO_LARGE INVALID_SERVICE)
 *       service = แถวตาราง services ({id, fee, fee_base, fee_per_sqm}) หรือรหัส 'SV-01' (อ่านแถวจาก db)
 *   calcDueAt(paidAt, slaDays, hol?)      → '2026-12-04T16:30:00+07:00'   (BR-12 · คำนวณครั้งเดียวตอนชำระ)
 *   calcDueAtForService(serviceId, paidAt, db?) → เหมือนบน แต่อ่าน SLA ของบริการจาก DB
 *   extendDueForNeedFix(dueAt, returnedAt, resubmittedAt, hol?) → ISO กำหนดเสร็จใหม่ (BR-13)
 *   needFixExtension(...)                 → {dueAt, pausedDays}  (ใช้บันทึก case_returns.paused_days)
 *   slaLevel(caseRow | dueAtIso, now?, hol?) → 'normal' | 'near' | 'overdue' | 'paused' | 'closed' | null
 *   slaInfo(caseRow, now?, hol?)          → {level, label, remaining, dueAt}
 *   remainingWorkdays(now, dueAt, hol?)   → จำนวนวันทำการใน (วันนี้, วันกำหนด]
 *   isOnTime(closedAt, dueAt)             → closedAt ≤ dueAt (รวมวินาที 16:30:00 · DECISIONS §18)
 *   isOverdue(now, dueAt)                 → now > dueAt
 *   isWorkday / nextWorkday / addWorkdays / countWorkdays  (ฟังก์ชันวันทำการตัวเดียวของทั้งระบบ)
 *
 * BUG_MODE (ตาม BUGS.md · กระทบเฉพาะการคำนวณใหม่ ไม่แตะข้อมูล seed)
 *   B01 SV-03 ใช้ `> 101` แทน `≥ 101` → พื้นที่ 101 = ฿1,000 (102 ยัง ฿1,020)
 *   B03 วันทำการไม่ดูตารางวันหยุด (ข้ามแค่ ส-อา) → กระทบ D0 กำหนดเสร็จ การขยายหยุดนับ และวันคงเหลือ
 *   B04 ส่งแก้แล้วกำหนดเสร็จไม่ขยาย (pausedDays = 0)
 *
 * ทดสอบ: `node server/lib/rules.js` (รัน unit test ค่าขอบทุกแถวในตัวไฟล์ · exit 1 ถ้าล้ม)
 */

const clock = require('./clock');
const bugmode = require('./bugmode');
const { LEVEL_TH } = require('./format');

// ---------------------------------------------------------------- ค่าคงที่ของกฎ
const CUTOFF_SEC = 16 * 3600 + 30 * 60; // 16:30:00 · ตั้งแต่วินาทีนี้ขึ้นไปนับเป็นวันทำการถัดไป (A-03)
const DUE_TIME = '16:30:00';
const QTY_MIN = 1;
const QTY_MAX = 5;
const QTY_DEFAULT = 1; // A-56
const AREA_MIN = 1;
const AREA_MAX = 500;
const AREA_BASE_MAX = 100; // 1–100 ตร.ม. = ค่าฐาน
const DEFAULTS = {
  'SV-01': { fee: 20, sla: 3 },
  'SV-02': { fee: 500, sla: 10 },
  'SV-03': { fee_base: 1000, fee_per_sqm: 10, sla: 15 },
};
const MESSAGES = {
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  INVALID_SERVICE: 'ไม่พบบริการ',
};
const CLOSED = new Set(['COMPLETED', 'REJECTED', 'CANCELLED']);
const SLA_RUNNING = new Set(['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED']);
const MAX_SCAN_DAYS = 3700; // กันวนไม่รู้จบถ้าตารางวันหยุดผิดปกติ (~10 ปี)

// ---------------------------------------------------------------- BUG_MODE
let bugOverride = null; // ใช้ใน self-test เท่านั้น
function bug(code) {
  return bugOverride ? bugOverride.has(code) : bugmode.isBug(code);
}

// ---------------------------------------------------------------- วันหยุด
function defaultDb() {
  return require('../db').db; // lazy: require ไฟล์นี้ไม่เปิด DB เอง
}

/** อ่านตาราง holidays → Set('YYYY-MM-DD') */
function loadHolidays(db) {
  const d = db || defaultDb();
  return new Set(d.prepare('SELECT date FROM holidays').all().map((r) => String(r.date).slice(0, 10)));
}

/** แปลงแหล่งวันหยุดทุกแบบเป็น Set */
function holidaySet(src) {
  if (src instanceof Set) return src;
  if (Array.isArray(src)) return new Set(src.map((x) => String(typeof x === 'string' ? x : x.date).slice(0, 10)));
  if (src && typeof src.prepare === 'function') return loadHolidays(src);
  if (src && src.db && typeof src.db.prepare === 'function') return loadHolidays(src.db);
  if (src === undefined || src === null) return loadHolidays(defaultDb());
  throw new TypeError('rules: holidays must be a db, Set or Array');
}

function resolveDb(db) {
  if (db && typeof db.prepare === 'function') return db;
  if (db && db.db && typeof db.db.prepare === 'function') return db.db;
  return defaultDb();
}

// ---------------------------------------------------------------- วันที่ (เวลาไทย · คีย์ 'YYYY-MM-DD')
function keyParts(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) throw new TypeError(`rules: invalid date key "${key}"`);
  return [+m[1], +m[2], +m[3]];
}
/** บวกวันปฏิทิน */
function addDays(key, n) {
  const [y, m, d] = keyParts(key);
  return clock.parts(clock.bkk(y, m, d + n, 12)).date;
}
function dowOf(key) {
  const [y, m, d] = keyParts(key);
  return clock.parts(clock.bkk(y, m, d, 12)).dow;
}
/** 'YYYY-MM-DD' ของเวลา (ISO/Date/ms) หรือคืนคีย์เดิมถ้าเป็นคีย์อยู่แล้ว */
function toKey(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return clock.dateKey(v);
}

// ---------------------------------------------------------------- วันทำการ (ตัวเดียวทั้งระบบ · DECISIONS §18)
/** จันทร์–ศุกร์ ที่ไม่อยู่ในตารางวันหยุด (B03: ไม่ดูตาราง) */
function isWorkday(day, hol) {
  const key = toKey(day);
  const dow = dowOf(key);
  if (dow === 0 || dow === 6) return false;
  if (bug('B03')) return true;
  return !holidaySet(hol).has(key);
}

/** วันทำการแรกที่อยู่หลังวันนี้ (ไม่รวมวันนี้) */
function nextWorkday(day, hol) {
  const h = holidaySet(hol);
  let d = toKey(day);
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    d = addDays(d, 1);
    if (isWorkday(d, h)) return d;
  }
  throw new Error('rules: no workday found');
}

/** วันทำการที่ n หลังวันนี้ (n = 0 → วันเดิม) */
function addWorkdays(day, n, hol) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`rules: workdays must be an integer ≥ 0 (got ${n})`);
  const h = holidaySet(hol);
  let d = toKey(day);
  for (let i = 0; i < n; i++) d = nextWorkday(d, h);
  return d;
}

/** จำนวนวันทำการในช่วง (fromExclusive, toInclusive] · ช่วงว่าง/กลับหัว → 0 */
function countWorkdays(fromExclusive, toInclusive, hol) {
  const h = holidaySet(hol);
  const end = toKey(toInclusive);
  let d = toKey(fromExclusive);
  let n = 0;
  for (let i = 0; i < MAX_SCAN_DAYS && d < end; i++) {
    d = addDays(d, 1);
    if (isWorkday(d, h)) n++;
  }
  return n;
}

// ---------------------------------------------------------------- ค่าธรรมเนียม (BR-04 BR-05 · DECISIONS §3)
/** จำนวนเต็มแบบเข้ม: 101 / "101" ✓ · 1.5 "1.5" "" "abc" null → NaN */
function strictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return NaN;
}
function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
  return undefined;
}
function num(v, dflt) {
  return v === null || v === undefined || v === '' ? dflt : Number(v);
}
function fail(code) {
  return { ok: false, status: 400, code, message: MESSAGES[code] };
}

function resolveService(service, db) {
  if (service && typeof service === 'object') return service;
  if (typeof service !== 'string') return null;
  return resolveDb(db).prepare('SELECT * FROM services WHERE id = ?').get(service) || null;
}

/**
 * ค่าธรรมเนียมจากแถวบริการ (ค่าที่ admin แก้ได้อยู่ในตาราง services)
 * SV-01 fee × qty (1–5 · ไม่ส่ง qty = 1) · SV-02 fee คงที่ · SV-03 fee_base (+ fee_per_sqm × (พื้นที่ − 100) ถ้า ≥ 101)
 */
function calcFee(service, input = {}, db) {
  const svc = resolveService(service, db);
  const id = svc && (svc.id || svc.service_id || svc.serviceId);
  if (!id || !DEFAULTS[id]) return fail('INVALID_SERVICE');
  const def = DEFAULTS[id];
  input = input || {};

  if (id === 'SV-01') {
    let raw = pick(input, 'qty', 'copies');
    if (raw === undefined || raw === null) raw = QTY_DEFAULT;
    const qty = strictInt(raw);
    if (!(qty >= QTY_MIN && qty <= QTY_MAX)) return fail('INVALID_QTY');
    return { ok: true, fee: qty * num(svc.fee, def.fee), qty };
  }

  if (id === 'SV-02') return { ok: true, fee: num(svc.fee, def.fee) };

  // SV-03
  const area = strictInt(pick(input, 'areaSqm', 'area_sqm', 'area'));
  if (!Number.isFinite(area) || area < AREA_MIN) return fail('INVALID_AREA');
  if (area > AREA_MAX) return fail('AREA_TOO_LARGE');
  const base = num(pick(svc, 'fee_base', 'feeBase'), def.fee_base);
  const perSqm = num(pick(svc, 'fee_per_sqm', 'feePerSqm'), def.fee_per_sqm);
  // B01: ใช้ `> 101` แทน `≥ 101` (101 ตกไปเป็นค่าฐาน)
  const tiered = bug('B01') ? area > AREA_BASE_MAX + 1 : area >= AREA_BASE_MAX + 1;
  const fee = tiered ? base + perSqm * (area - AREA_BASE_MAX) : base;
  return { ok: true, fee, areaSqm: area };
}

// ---------------------------------------------------------------- กำหนดเสร็จ (BR-12 · DECISIONS §8)
/** D0: วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 · ไม่เช่นนั้นวันทำการถัดไป */
function calcD0(paidAt, hol) {
  const h = holidaySet(hol);
  const p = clock.parts(paidAt);
  const sec = p.hh * 3600 + p.mm * 60 + p.ss;
  if (isWorkday(p.date, h) && sec < CUTOFF_SEC) return p.date;
  return nextWorkday(p.date, h);
}

/** กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30 (ใช้ตารางวันหยุด ณ ตอนชำระ · ไม่คำนวณใหม่ภายหลัง) */
function calcDueAt(paidAt, slaDays, hol) {
  const n = strictInt(slaDays);
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`rules: SLA must be an integer ≥ 0 (got ${slaDays})`);
  const h = holidaySet(hol);
  return `${addWorkdays(calcD0(paidAt, h), n, h)}T${DUE_TIME}+07:00`;
}

/** SLA (วันทำการ) ของบริการจาก DB */
function slaDaysFor(serviceId, db) {
  const row = resolveService(serviceId, db);
  const id = row && (row.id || serviceId);
  const v = row ? num(row.sla, DEFAULTS[id] && DEFAULTS[id].sla) : DEFAULTS[serviceId] && DEFAULTS[serviceId].sla;
  if (!Number.isInteger(v)) throw new Error(`rules: unknown service "${serviceId}"`);
  return v;
}

function calcDueAtForService(serviceId, paidAt, db) {
  const d = resolveDb(db);
  return calcDueAt(paidAt, slaDaysFor(serviceId, d), d);
}

// ---------------------------------------------------------------- หยุดนับ NEED_FIX (BR-13)
/**
 * กำหนดใหม่ = กำหนดเดิม + จำนวนวันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้] (นับตามวันที่ ไม่ดูเวลา)
 * ใช้ตารางวันหยุด ณ เวลาที่เรียก (= ตอนส่งแก้) · เวลาในวันของกำหนดเดิม (16:30) คงไว้
 */
function needFixExtension(dueAt, returnedAt, resubmittedAt, hol) {
  const original = clock.toIso(dueAt);
  if (bug('B04')) return { dueAt: original, pausedDays: 0 }; // B04: ไม่หยุดนับ
  const h = holidaySet(hol);
  const k = countWorkdays(toKey(returnedAt), toKey(resubmittedAt), h);
  if (k === 0) return { dueAt: original, pausedDays: 0 };
  const p = clock.parts(dueAt);
  return { dueAt: `${addWorkdays(p.date, k, h)}T${p.time}+07:00`, pausedDays: k };
}

function extendDueForNeedFix(dueAt, returnedAt, resubmittedAt, hol) {
  return needFixExtension(dueAt, returnedAt, resubmittedAt, hol).dueAt;
}

// ---------------------------------------------------------------- ระดับเตือน (BR-14 · CONTRACT 4.2)
/** วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนดเสร็จ (รวมวันกำหนด) */
function remainingWorkdays(now, dueAt, hol) {
  return countWorkdays(toKey(now), toKey(dueAt), hol);
}

function isOverdue(now, dueAt) {
  return clock.cmp(now, dueAt) > 0;
}

/** ทันกำหนด ⇔ closed_at ≤ กำหนดเสร็จ (16:30:00 ยังทัน · 16:30:01 ไม่ทัน) */
function isOnTime(closedAt, dueAt) {
  return clock.cmp(closedAt, dueAt) <= 0;
}

function caseFields(c) {
  if (typeof c === 'string' || c instanceof Date) return { status: 'IN_REVIEW', dueAt: c };
  return { status: c && c.status, dueAt: c && (c.dueAt !== undefined ? c.dueAt : c.due_at) };
}

/**
 * {level, label, remaining, dueAt}
 * closed (COMPLETED/REJECTED/CANCELLED) · paused (NEED_FIX) · overdue (now > due) · near (เหลือ ≤ 1) · normal (เหลือ ≥ 2)
 * DRAFT/PENDING_PAYMENT หรือไม่มีกำหนด → level null
 */
function slaInfo(c, now, hol) {
  const { status, dueAt } = caseFields(c);
  const out = (level, remaining = null) => ({ level, label: level ? LEVEL_TH[level] : '', remaining, dueAt: dueAt ? clock.toIso(dueAt) : null });
  if (CLOSED.has(status)) return out('closed');
  if (status === 'NEED_FIX') return out('paused');
  if (!dueAt || (status !== undefined && !SLA_RUNNING.has(status))) return out(null);
  const t = now === undefined || now === null ? clock.now() : now;
  if (isOverdue(t, dueAt)) return out('overdue');
  const remaining = remainingWorkdays(t, dueAt, hol);
  return out(remaining >= 2 ? 'normal' : 'near', remaining);
}

function slaLevel(c, now, hol) {
  return slaInfo(c, now, hol).level;
}

module.exports = {
  // ค่าคงที่
  CUTOFF_SEC, DUE_TIME, QTY_MIN, QTY_MAX, QTY_DEFAULT, AREA_MIN, AREA_MAX, AREA_BASE_MAX, DEFAULTS, MESSAGES,
  // วันหยุด/วันทำการ
  loadHolidays, isWorkday, nextWorkday, addWorkdays, countWorkdays, addDays,
  // กฎ
  calcFee, calcD0, calcDueAt, calcDueAtForService, slaDaysFor,
  needFixExtension, extendDueForNeedFix,
  remainingWorkdays, isOverdue, isOnTime, slaInfo, slaLevel,
};

// ================================================================ self-test: node server/lib/rules.js
if (require.main === module) {
  const assert = require('assert');
  let memDb;
  try {
    const Database = require('better-sqlite3');
    memDb = new Database(':memory:');
    memDb.exec(`CREATE TABLE holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
      CREATE TABLE services (id TEXT PRIMARY KEY, name TEXT NOT NULL, fee INTEGER, fee_base INTEGER, fee_per_sqm INTEGER, sla INTEGER NOT NULL, sort INTEGER NOT NULL DEFAULT 0, updated_at TEXT);`);
  } catch (e) {
    // ไม่มี native module บนเครื่องนี้ → ใช้ DB จำลองที่ตอบ SQL สองคำสั่งที่ไฟล์นี้ใช้
    const tables = { holidays: [], services: [] };
    memDb = {
      fake: true,
      prepare(sql) {
        if (/FROM holidays/.test(sql)) return { all: () => tables.holidays.slice() };
        if (/FROM services WHERE id/.test(sql)) return { get: (id) => tables.services.find((r) => r.id === id) };
        throw new Error(`fake db: ${sql}`);
      },
      tables,
    };
  }
  const addHoliday = (date) => (memDb.fake ? memDb.tables.holidays.push({ date }) : memDb.prepare('INSERT INTO holidays(date, name) VALUES (?, ?)').run(date, 'ทดสอบ'));
  const delHoliday = (date) => (memDb.fake
    ? (memDb.tables.holidays = memDb.tables.holidays.filter((r) => r.date !== date))
    : memDb.prepare('DELETE FROM holidays WHERE date = ?').run(date));
  const setService = (r) => (memDb.fake
    ? (memDb.tables.services = memDb.tables.services.filter((x) => x.id !== r.id).concat([r]))
    : memDb.prepare('INSERT OR REPLACE INTO services(id, name, fee, fee_base, fee_per_sqm, sla) VALUES (@id, @name, @fee, @fee_base, @fee_per_sqm, @sla)').run(r));
  ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01'].forEach(addHoliday); // seed A-02
  setService({ id: 'SV-01', name: 'ขอหนังสือรับรอง', fee: 20, fee_base: null, fee_per_sqm: null, sla: 3 });
  setService({ id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ', fee: 500, fee_base: null, fee_per_sqm: null, sla: 10 });
  setService({ id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', fee: null, fee_base: 1000, fee_per_sqm: 10, sla: 15 });

  const results = [];
  const test = (name, fn) => {
    try { fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
  };
  const withBugs = (codes, fn) => {
    const prev = bugOverride;
    bugOverride = new Set(codes);
    try { fn(); } finally { bugOverride = prev; }
  };
  const T = (s) => `${s}+07:00`; // '2026-12-01T09:00:00' → ISO +07:00
  const D = (day) => `${day}T16:30:00+07:00`;
  const fee = (sv, input) => calcFee(sv, input, memDb);
  const okFee = (sv, input, want) => {
    const r = fee(sv, input);
    assert.strictEqual(r.ok, true, `${sv} ${JSON.stringify(input)} expected ok, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.fee, want, `${sv} ${JSON.stringify(input)} expected ฿${want} received ฿${r.fee}`);
  };
  const badFee = (sv, input, code) => {
    const r = fee(sv, input);
    assert.strictEqual(r.ok, false, `${sv} ${JSON.stringify(input)} expected ${code}, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.code, code);
    assert.strictEqual(r.message, MESSAGES[code]);
  };
  const due = (paid, sla) => calcDueAt(T(paid), sla, memDb);
  const lvl = (dueAt, now, status = 'IN_REVIEW') => slaLevel({ status, dueAt }, T(now), memDb);

  // ---- BR-04 SV-01 (bypass bugs ทั้งหมด = เว็บถูกต้อง)
  withBugs([], () => {
    test('BR-04 SV-01 qty 0 ✗ INVALID_QTY', () => badFee('SV-01', { qty: 0 }, 'INVALID_QTY'));
    test('BR-04 SV-01 qty 1 → ฿20', () => okFee('SV-01', { qty: 1 }, 20));
    test('BR-04 SV-01 qty 2 → ฿40 (CONTRACT ตัวอย่าง)', () => okFee('SV-01', { qty: 2 }, 40));
    test('BR-04 SV-01 qty 5 → ฿100', () => okFee('SV-01', { qty: 5 }, 100));
    test('BR-04 SV-01 qty 6 ✗ INVALID_QTY', () => badFee('SV-01', { qty: 6 }, 'INVALID_QTY'));
    test('BR-04 SV-01 qty -1 / 1.5 / "" / "abc" ✗', () => {
      for (const q of [-1, 1.5, '', 'abc', '2.0', NaN]) badFee('SV-01', { qty: q }, 'INVALID_QTY');
    });
    test('BR-04 SV-01 qty "3" (ฟอร์ม) → ฿60 · ไม่ส่ง qty → ค่าตั้งต้น 1 (A-56)', () => {
      okFee('SV-01', { qty: '3' }, 60);
      okFee('SV-01', {}, 20);
    });
    test('BR-05 SV-02 → ฿500 คงที่', () => okFee('SV-02', {}, 500));

    // ---- BR-05 SV-03 ทุกแถว TC-FEE-01
    test('BR-05 SV-03 area 0 ✗ INVALID_AREA', () => badFee('SV-03', { areaSqm: 0 }, 'INVALID_AREA'));
    test('BR-05 SV-03 area -1 ✗ INVALID_AREA', () => badFee('SV-03', { areaSqm: -1 }, 'INVALID_AREA'));
    const rows = [[1, 1000], [100, 1000], [101, 1010], [102, 1020], [250, 2500], [300, 3000], [499, 4990], [500, 5000]];
    for (const [a, f] of rows) test(`BR-05 SV-03 area ${a} → ฿${f.toLocaleString('en-US')}`, () => okFee('SV-03', { areaSqm: a }, f));
    test('BR-05 SV-03 area 501 ✗ AREA_TOO_LARGE', () => badFee('SV-03', { areaSqm: 501 }, 'AREA_TOO_LARGE'));
    test('BR-05 SV-03 area ไม่ใช่จำนวนเต็ม/ว่าง ✗ INVALID_AREA', () => {
      for (const a of [undefined, null, '', 'abc', 100.5, '1.5']) badFee('SV-03', { areaSqm: a }, 'INVALID_AREA');
    });
    test('BR-05 SV-03 area "101" (ฟอร์ม) / area_sqm → ฿1,010', () => {
      okFee('SV-03', { areaSqm: '101' }, 1010);
      okFee('SV-03', { area_sqm: 101 }, 1010);
    });
    test('ค่าธรรมเนียมอ่านจากแถว services (admin แก้ SV-01 25 · SV-02 600 → ฿125 / ฿600)', () => {
      okFee({ id: 'SV-01', fee: 25 }, { qty: 5 }, 125);
      okFee({ id: 'SV-02', fee: 600 }, {}, 600);
      setService({ id: 'SV-01', name: 'x', fee: 25, fee_base: null, fee_per_sqm: null, sla: 3 });
      okFee('SV-01', { qty: 1 }, 25);
      setService({ id: 'SV-01', name: 'x', fee: 20, fee_base: null, fee_per_sqm: null, sla: 3 });
    });
    test('บริการไม่รู้จัก ✗ INVALID_SERVICE', () => assert.strictEqual(fee('SV-99', {}).code, 'INVALID_SERVICE'));
    test('ข้อความ error ตรง CONTRACT §5', () => {
      assert.strictEqual(MESSAGES.INVALID_QTY, 'จำนวนฉบับต้อง 1–5 ฉบับ');
      assert.strictEqual(MESSAGES.INVALID_AREA, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.');
      assert.strictEqual(MESSAGES.AREA_TOO_LARGE, 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน');
    });

    // ---- BR-12 TC-SLA-01 ทุกแถว + ค่าขอบวินาที
    const slaRows = [
      ['a', '2026-12-01T09:00:00', 3, '2026-12-04'],
      ['b', '2026-12-01T16:29:00', 3, '2026-12-04'],
      ['b+', '2026-12-01T16:29:59', 3, '2026-12-04'],
      ['c', '2026-12-01T16:30:00', 3, '2026-12-08'],
      ['c+', '2026-12-01T16:30:01', 3, '2026-12-08'],
      ['d', '2026-12-04T10:00:00', 3, '2026-12-11'],
      ['e', '2026-12-05T10:00:00', 3, '2026-12-14'],
      ['f SV-02', '2026-12-01T09:00:00', 10, '2026-12-17'],
      ['g SV-03', '2026-12-01T09:00:00', 15, '2026-12-24'],
      ['h ข้ามปี', '2026-12-29T10:00:00', 3, '2027-01-05'],
      ['i ข้ามปี', '2026-12-31T23:59:00', 3, '2027-01-07'],
      ['อา.6 ธ.ค.', '2026-12-06T10:00:00', 3, '2026-12-14'],
      ['จ.7 วันหยุด', '2026-12-07T09:00:00', 3, '2026-12-14'],
      ['1 ม.ค. 70 00:00', '2027-01-01T00:00:00', 3, '2027-01-07'],
    ];
    for (const [name, paid, sla, want] of slaRows) {
      test(`BR-12 แถว ${name}: ชำระ ${paid} SLA ${sla} → ${want} 16:30`, () => assert.strictEqual(due(paid, sla), D(want)));
    }
    test('BR-12 ค่าขอบ 16:29:59 vs 16:30:00 → 4 vs 8 ธ.ค.', () => {
      assert.strictEqual(due('2026-12-01T16:29:59', 3), D('2026-12-04'));
      assert.strictEqual(due('2026-12-01T16:30:00', 3), D('2026-12-08'));
    });
    test('BR-12 รับเวลาเขต UTC (09:29:59Z = 16:29:59 ไทย · 09:30:00Z = 16:30)', () => {
      assert.strictEqual(calcDueAt('2026-12-01T09:29:59Z', 3, memDb), D('2026-12-04'));
      assert.strictEqual(calcDueAt('2026-12-01T09:30:00Z', 3, memDb), D('2026-12-08'));
    });
    test('BR-12 calcDueAtForService อ่าน SLA จาก DB (SV-01 3 · SV-02 10 · SV-03 15)', () => {
      assert.strictEqual(calcDueAtForService('SV-01', T('2026-12-01T09:00:00'), memDb), D('2026-12-04'));
      assert.strictEqual(calcDueAtForService('SV-02', T('2026-12-01T09:00:00'), memDb), D('2026-12-17'));
      assert.strictEqual(calcDueAtForService('SV-03', T('2026-12-01T09:00:00'), memDb), D('2026-12-24'));
    });
    test('BR-12 วันหยุดอ่านจาก DB ล่าสุด (TC-RBAC-04: เพิ่ม 2 ธ.ค. → 8 ธ.ค. · ลบ → 4 ธ.ค.)', () => {
      addHoliday('2026-12-02');
      try { assert.strictEqual(due('2026-12-01T09:00:00', 3), D('2026-12-08')); } finally { delHoliday('2026-12-02'); }
      assert.strictEqual(due('2026-12-01T09:00:00', 3), D('2026-12-04'));
    });
    test('BR-12 รับ Set/Array วันหยุดได้เท่ากับ DB', () => {
      const s = loadHolidays(memDb);
      assert.strictEqual(calcDueAt(T('2026-12-01T16:30:00'), 3, s), D('2026-12-08'));
      assert.strictEqual(calcDueAt(T('2026-12-01T16:30:00'), 3, [...s]), D('2026-12-08'));
    });

    // ---- BR-13 TC-SLA-02
    const ext = (d, r, s) => needFixExtension(D(d), T(r), T(s), memDb);
    test('BR-13 ส่วน 1: ตีกลับ พ.2 11:00 ส่งแก้ พฤ.3 10:00 → หยุด 1 → 8 ธ.ค.', () => {
      assert.deepStrictEqual(ext('2026-12-04', '2026-12-02T11:00:00', '2026-12-03T10:00:00'), { dueAt: D('2026-12-08'), pausedDays: 1 });
      assert.strictEqual(extendDueForNeedFix(D('2026-12-04'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), memDb), D('2026-12-08'));
    });
    test('BR-13 ส่วน 2: seed …000017 ตีกลับ 27 พ.ย. 14:00 ส่งแก้ 1 ธ.ค. 09:00 → หยุด 2 → 1 ธ.ค.', () => {
      assert.deepStrictEqual(ext('2026-11-27', '2026-11-27T14:00:00', '2026-12-01T09:00:00'), { dueAt: D('2026-12-01'), pausedDays: 2 });
    });
    test('BR-13 ส่วน 3: seed …000017 ส่งแก้ 4 ธ.ค. 10:00 → หยุด 5 → 4 ธ.ค.', () => {
      assert.deepStrictEqual(ext('2026-11-27', '2026-11-27T14:00:00', '2026-12-04T10:00:00'), { dueAt: D('2026-12-04'), pausedDays: 5 });
    });
    test('BR-13 ส่วน 4: ตีกลับและส่งแก้วันเดียวกัน → หยุด 0 → 4 ธ.ค.', () => {
      assert.deepStrictEqual(ext('2026-12-04', '2026-12-02T09:00:00', '2026-12-02T15:00:00'), { dueAt: D('2026-12-04'), pausedDays: 0 });
    });
    test('BR-13 ส่วน 5: ตีกลับ ศ.4 ส่งแก้ อ.8 17:00 → หยุด 1 (ส อา จ.7 ไม่นับ) → 8 ธ.ค. · เกินกำหนดทันที', () => {
      const r = ext('2026-12-04', '2026-12-04T10:00:00', '2026-12-08T17:00:00');
      assert.deepStrictEqual(r, { dueAt: D('2026-12-08'), pausedDays: 1 });
      assert.strictEqual(lvl(r.dueAt, '2026-12-08T17:00:00'), 'overdue');
    });
    test('BR-13 seed …000017 ตีกลับครั้งที่ 1 (24→25 พ.ย.) หยุด 1 วัน (TEST-DATA 4.4)', () => {
      assert.strictEqual(ext('2026-11-26', '2026-11-24T11:00:00', '2026-11-25T10:00:00').pausedDays, 1);
    });
    test('BR-13 ใช้ตารางวันหยุด ณ ตอนส่งแก้ (เพิ่มหยุด 3 ธ.ค. → หยุด 0 วัน)', () => {
      addHoliday('2026-12-03');
      try { assert.deepStrictEqual(ext('2026-12-04', '2026-12-02T11:00:00', '2026-12-03T10:00:00'), { dueAt: D('2026-12-04'), pausedDays: 0 }); } finally { delHoliday('2026-12-03'); }
    });

    // ---- BR-14 TC-SLA-03
    const partA = [
      ['2026-12-01T09:00:00', 'normal', 3], ['2026-12-02T09:00:00', 'normal', 2], ['2026-12-03T09:00:00', 'near', 1],
      ['2026-12-04T16:29:59', 'near', 0], ['2026-12-04T16:30:00', 'near', 0], ['2026-12-04T16:30:01', 'overdue', null],
      ['2026-12-04T16:31:00', 'overdue', null], ['2026-12-05T10:00:00', 'overdue', null],
    ];
    for (const [now, want, rem] of partA) {
      test(`BR-14 ส่วน A กำหนด 4 ธ.ค. 16:30 · ${now} → ${want}${rem === null ? '' : ` (${rem})`}`, () => {
        const info = slaInfo({ status: 'IN_REVIEW', due_at: D('2026-12-04') }, T(now), memDb);
        assert.strictEqual(info.level, want);
        assert.strictEqual(info.remaining, rem);
        assert.strictEqual(info.label, LEVEL_TH[want]);
      });
    }
    const partB = [
      ['2026-12-03T09:00:00', 'normal', 2], ['2026-12-04T09:00:00', 'near', 1], ['2026-12-05T10:00:00', 'near', 1],
      ['2026-12-08T16:30:00', 'near', 0], ['2026-12-08T16:31:00', 'overdue', null],
    ];
    for (const [now, want, rem] of partB) {
      test(`BR-14 ส่วน B กำหนด 8 ธ.ค. (คั่น ส-อา + จ.7) · ${now} → ${want}`, () => {
        const info = slaInfo({ status: 'IN_REVIEW', dueAt: D('2026-12-08') }, T(now), memDb);
        assert.strictEqual(info.level, want);
        assert.strictEqual(info.remaining, rem);
      });
    }
    test('BR-14 ส่วน C ณ 1 ธ.ค. 09:00 (30 พ.ย. เกิน · 1 ธ.ค. ใกล้ 0 · 2 ธ.ค. ใกล้ 1 · 3 ธ.ค. ปกติ 2)', () => {
      assert.strictEqual(lvl(D('2026-11-30'), '2026-12-01T09:00:00'), 'overdue');
      assert.strictEqual(lvl(D('2026-12-01'), '2026-12-01T09:00:00'), 'near');
      assert.strictEqual(lvl(D('2026-12-02'), '2026-12-01T09:00:00'), 'near');
      assert.strictEqual(lvl(D('2026-12-03'), '2026-12-01T09:00:00'), 'normal');
      assert.strictEqual(lvl(D('2026-12-01'), '2026-12-01T16:30:00'), 'near');
      assert.strictEqual(lvl(D('2026-12-01'), '2026-12-01T16:31:00'), 'overdue');
    });
    test('BR-14 สถานะ: NEED_FIX → paused · COMPLETED/REJECTED/CANCELLED → closed · ร่าง → null', () => {
      assert.strictEqual(lvl(D('2026-11-27'), '2026-12-01T09:00:00', 'NEED_FIX'), 'paused');
      for (const s of ['COMPLETED', 'REJECTED', 'CANCELLED']) assert.strictEqual(lvl(D('2026-11-27'), '2026-12-01T09:00:00', s), 'closed');
      for (const s of ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED']) assert.strictEqual(lvl(D('2026-12-04'), '2026-12-01T09:00:00', s), 'normal');
      assert.strictEqual(lvl(D('2026-12-04'), '2026-12-01T09:00:00', 'PENDING_PAYMENT'), null);
      assert.strictEqual(slaLevel({ status: 'IN_REVIEW', dueAt: null }, T('2026-12-01T09:00:00'), memDb), null);
      assert.strictEqual(slaInfo({ status: 'NEED_FIX' }, T('2026-12-01T09:00:00'), memDb).label, 'หยุดนับ');
    });
    test('BR-14 หลังส่งแก้ (TC-SLA-02): 8 ธ.ค. ณ 3 ธ.ค. → ปกติ · 1 ธ.ค. ณ 1 ธ.ค. 09:00 → ใกล้ (0)', () => {
      assert.strictEqual(lvl(D('2026-12-08'), '2026-12-03T10:00:00'), 'normal');
      assert.strictEqual(lvl(D('2026-12-01'), '2026-12-01T09:00:00'), 'near');
      assert.strictEqual(lvl(D('2026-12-04'), '2026-12-04T10:00:00'), 'near');
    });
    test('ทันกำหนด: ปิด 16:29:59 ทัน · 16:30:00 ทัน · 16:30:01 / 16:31 ไม่ทัน (DECISIONS §18)', () => {
      assert.strictEqual(isOnTime(T('2026-12-03T16:29:59'), D('2026-12-03')), true);
      assert.strictEqual(isOnTime(T('2026-12-03T16:30:00'), D('2026-12-03')), true);
      assert.strictEqual(isOnTime(T('2026-12-03T16:30:01'), D('2026-12-03')), false);
      assert.strictEqual(isOnTime(T('2026-12-03T16:31:00'), D('2026-12-03')), false);
      assert.strictEqual(isOverdue(T('2026-12-03T16:30:00'), D('2026-12-03')), false);
      assert.strictEqual(isOverdue(T('2026-12-03T16:30:01'), D('2026-12-03')), true);
    });
  });

  // ---- BUG_MODE
  withBugs(['B01'], () => {
    test('B01: area 101 → ฿1,000 (102 ยัง ฿1,020 · 100 ฿1,000 · 500 ฿5,000)', () => {
      okFee('SV-03', { areaSqm: 101 }, 1000);
      okFee('SV-03', { areaSqm: 102 }, 1020);
      okFee('SV-03', { areaSqm: 100 }, 1000);
      okFee('SV-03', { areaSqm: 500 }, 5000);
      badFee('SV-03', { areaSqm: 501 }, 'AREA_TOO_LARGE');
    });
    test('B01 ไม่กระทบ SLA', () => assert.strictEqual(due('2026-12-01T16:30:00', 3), D('2026-12-08')));
  });
  withBugs(['B03'], () => {
    test('B03: ข้ามแค่ ส-อา (c → 7 ธ.ค. · d → 9 · e → 10 · h → 1 ม.ค. · i → 6 ม.ค. · a ยัง 4)', () => {
      assert.strictEqual(due('2026-12-01T09:00:00', 3), D('2026-12-04'));
      assert.strictEqual(due('2026-12-01T16:30:00', 3), D('2026-12-07'));
      assert.strictEqual(due('2026-12-04T10:00:00', 3), D('2026-12-09'));
      assert.strictEqual(due('2026-12-05T10:00:00', 3), D('2026-12-10'));
      assert.strictEqual(due('2026-12-29T10:00:00', 3), D('2027-01-01'));
      assert.strictEqual(due('2026-12-31T23:59:00', 3), D('2027-01-06'));
    });
    test('B03: หยุดนับแถว 6 ได้ 7 ธ.ค. แทน 8 ธ.ค.', () => {
      assert.strictEqual(extendDueForNeedFix(D('2026-12-04'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), memDb), D('2026-12-07'));
    });
    test('B03: วันคงเหลือข้าม 7 ธ.ค. → seed …000016 ณ ศ.4 09:00 ได้ ปกติ แทน ใกล้', () => {
      assert.strictEqual(lvl(D('2026-12-08'), '2026-12-04T09:00:00'), 'normal');
    });
    test('B03: วันหยุด 2 ธ.ค. ที่ admin เพิ่มไม่ถูกนับ (TC-RBAC-04)', () => {
      addHoliday('2026-12-02');
      try { assert.strictEqual(due('2026-12-01T09:00:00', 3), D('2026-12-04')); } finally { delHoliday('2026-12-02'); }
    });
    test('B03 ไม่กระทบค่าธรรมเนียม', () => okFee('SV-03', { areaSqm: 101 }, 1010));
  });
  withBugs(['B04'], () => {
    test('B04: ตีกลับ พ.2 ส่งแก้ พฤ.3 → ยัง 4 ธ.ค.', () => {
      assert.deepStrictEqual(needFixExtension(D('2026-12-04'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), memDb), { dueAt: D('2026-12-04'), pausedDays: 0 });
    });
    test('B04: seed …000017 ส่งแก้ 1 ธ.ค. → ยัง 27 พ.ย. และ เกินกำหนด', () => {
      const d = extendDueForNeedFix(D('2026-11-27'), T('2026-11-27T14:00:00'), T('2026-12-01T09:00:00'), memDb);
      assert.strictEqual(d, D('2026-11-27'));
      assert.strictEqual(lvl(d, '2026-12-01T09:00:00'), 'overdue');
    });
    test('B04 ไม่กระทบกำหนดเสร็จตอนชำระและสถานะหยุดนับ', () => {
      assert.strictEqual(due('2026-12-01T16:30:00', 3), D('2026-12-08'));
      assert.strictEqual(lvl(D('2026-11-27'), '2026-12-01T09:00:00', 'NEED_FIX'), 'paused');
    });
  });
  withBugs(['B03', 'B04', 'B01'], () => {
    test('รวม B01,B03,B04 = union ของแต่ละตัว', () => {
      okFee('SV-03', { areaSqm: 101 }, 1000);
      assert.strictEqual(due('2026-12-01T16:30:00', 3), D('2026-12-07'));
      assert.strictEqual(extendDueForNeedFix(D('2026-12-04'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), memDb), D('2026-12-04'));
    });
  });
  withBugs(['B02', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12'], () => {
    test('บั๊กอื่นไม่กระทบกฎตัวเลข', () => {
      okFee('SV-03', { areaSqm: 101 }, 1010);
      assert.strictEqual(due('2026-12-01T16:30:00', 3), D('2026-12-08'));
      assert.strictEqual(extendDueForNeedFix(D('2026-12-04'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), memDb), D('2026-12-08'));
      assert.strictEqual(lvl(D('2026-12-08'), '2026-12-04T09:00:00'), 'near');
    });
  });

  const failed = results.filter((r) => !r[0]);
  for (const [ok, name, err] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     → ${err}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed${memDb.fake ? ' (fake db)' : ' (better-sqlite3 :memory:)'}`);
  process.exit(failed.length ? 1 : 0);
}
