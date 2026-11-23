'use strict';
/**
 * ล้างทุกอย่าง + seed ใหม่ (POST /api/test/reset และตอนเริ่มระบบครั้งแรกที่ DB ว่าง)
 *  1) DROP ทุกตาราง (รวม sessions → ทุกคนต้องล็อกอินใหม่ · otp_attempts · notifications · audit_log)
 *  2) ลบไฟล์ทั้งหมดใน UPLOAD_DIR
 *  3) นาฬิกากลับค่าเริ่มต้น (TEST_MODE: 2026-12-01T09:00:00+07:00)
 *  4) hooks.onReset (ล้าง cache ในหน่วยความจำของโมดูลอื่น)
 *  5) seed: server/seed.js (บล็อก B02) · export `seed(ctx)` หรือ module.exports = function(ctx)
 *  6) hooks.onAfterSeed
 */
const fs = require('fs');
const path = require('path');
const dbm = require('../db');
const clock = require('./clock');
const hooks = require('./hooks');

const SEED_PATH = path.join(__dirname, '..', 'seed.js');

function loadSeed() {
  if (!fs.existsSync(SEED_PATH)) return null;
  const mod = require(SEED_PATH);
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.seed === 'function') return mod.seed;
  throw new Error('server/seed.js ต้อง export seed(ctx)');
}

function seedCtx() {
  return {
    db: dbm.db, dbm, clock, nextSeq: dbm.nextSeq, setSeq: dbm.setSeq, UPLOAD_DIR: dbm.UPLOAD_DIR,
    pii: require('./pii'), password: require('./password'), bug: require('./bugmode'),
  };
}

function resetAll() {
  dbm.wipe();
  dbm.clearUploads();
  const now = clock.reset();
  hooks.runReset();
  const seed = loadSeed();
  if (seed) seed(seedCtx());
  else console.warn('[reset] ยังไม่มี server/seed.js · ฐานข้อมูลว่าง');
  dbm.setMeta('seeded_at', clock.nowIso());
  hooks.runAfterSeed();
  return now;
}

/** ตอนเริ่มระบบ: ถ้ายังไม่เคย seed → reset หนึ่งครั้ง */
function ensureSeeded() {
  if (dbm.getMeta('seeded_at')) return false;
  resetAll();
  return true;
}

module.exports = { resetAll, ensureSeeded, loadSeed };
