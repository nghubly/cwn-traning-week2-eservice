'use strict';
/**
 * ฐานข้อมูล SQLite (better-sqlite3 · synchronous) · ไฟล์ที่ DB_PATH
 * ใช้: const { db } = require('../db');  db.prepare('SELECT ...').get(...)
 * handle `db` เป็นตัวเดียวตลอดอายุโปรเซส (reset ไม่ปิด/เปิดใหม่ จึงเก็บอ้างอิงไว้ได้)
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'egov.db'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads'));
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
// WAL ใช้ shared memory (mmap ไฟล์ -shm) ซึ่งล้มด้วย SIGBUS เมื่อ ./data เป็น bind mount จาก Windows/macOS
// ค่าเริ่มต้นจึงเป็น DELETE (ใช้ได้ทุกเครื่อง) · ตั้ง SQLITE_JOURNAL_MODE=WAL ได้เมื่อ DB อยู่บน filesystem ของ Linux
const JOURNAL_MODE = /^(WAL|DELETE|TRUNCATE|PERSIST)$/i.test(process.env.SQLITE_JOURNAL_MODE || '')
  ? process.env.SQLITE_JOURNAL_MODE.toUpperCase()
  : 'DELETE';
db.pragma(`journal_mode = ${JOURNAL_MODE}`);
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('secure_delete = ON'); // เขียนทับหน้าที่ลบด้วยศูนย์ (PDPA)
db.pragma('busy_timeout = 5000');

function applySchema() {
  db.exec(SCHEMA);
}

/** ลบทุกตาราง/trigger แล้วสร้าง schema ใหม่ (ใช้ใน reset) */
function wipe() {
  db.pragma('foreign_keys = OFF');
  try {
    const objs = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger','index','view') AND name NOT LIKE 'sqlite_%'",
    ).all();
    db.transaction(() => {
      for (const o of objs.filter((x) => x.type === 'trigger')) db.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
      for (const o of objs.filter((x) => x.type === 'view')) db.exec(`DROP VIEW IF EXISTS "${o.name}"`);
      for (const o of objs.filter((x) => x.type === 'table')) db.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      db.exec(SCHEMA);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if (JOURNAL_MODE === 'WAL') db.pragma('wal_checkpoint(TRUNCATE)');
}

/** เลขรันถัดไปแบบ atomic (เรียกใน transaction ของผู้เรียกได้) · nextSeq('case:2569') → 31 */
const _getCounter = () => db.prepare('SELECT value FROM counters WHERE name = ?');
function nextSeq(name) {
  db.prepare('INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(name);
  return _getCounter().get(name).value;
}
/** ตั้งค่าตัวนับ (seed ใช้ เช่น setSeq('case:2569', 30)) */
function setSeq(name, value) {
  db.prepare('INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
}

function getMeta(key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** ล้างไฟล์อัปโหลดทั้งหมดใน UPLOAD_DIR (seed สร้างไฟล์ของตัวเองใหม่) */
function clearUploads() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { recursive: true, force: true });
}

applySchema();

module.exports = { db, DB_PATH, UPLOAD_DIR, applySchema, wipe, nextSeq, setSeq, getMeta, setMeta, clearUploads };
