'use strict';
/**
 * Test hook (CONTRACT 8) · ทำงานเฉพาะ TEST_MODE=1 (app.js ตอบ 404 ให้ /api/test/* เมื่อไม่ตั้ง)
 *   POST /api/test/reset  → 200 {"ok":true,"now":"2026-12-01T09:00:00+07:00"}
 *   GET  /api/test/clock  → 200 {"now":"…"}
 *   PUT  /api/test/clock  {"now":"<ISO มี offset>"} → 200 {"now":"…+07:00"} (แช่แข็ง) · 400 INVALID_TIME
 * ส่วน /api/test/payments/<ref>/pay และ /api/test/documents/<docNo>/tamper อยู่ในไฟล์ของบล็อกชำระเงิน/เอกสาร
 */
const express = require('express');
const clock = require('../lib/clock');
const bug = require('../lib/bugmode');
const { resetAll } = require('../lib/reset');
const { DB_PATH } = require('../db');

const router = express.Router();

router.post('/api/test/reset', (req, res, next) => {
  try {
    const now = resetAll();
    res.json({ ok: true, now });
  } catch (e) { next(e); }
});

router.get('/api/test/clock', (req, res) => {
  res.json({ now: clock.nowIso() });
});

router.put('/api/test/clock', (req, res) => {
  const v = req.body && req.body.now;
  const now = clock.setNow(v);
  if (!now) return res.status(400).json({ code: 'INVALID_TIME', message: 'รูปแบบเวลาไม่ถูกต้อง ต้องเป็น ISO 8601 พร้อม offset เช่น 2026-12-01T09:00:00+07:00' });
  res.json({ now });
});

// ข้อมูลช่วยดีบักของชุดทดสอบ (ไม่อยู่ใน CONTRACT · test กลางไม่ใช้)
router.get('/api/test/info', (req, res) => {
  res.json({ testMode: true, bugMode: bug.list(), dbPath: DB_PATH, now: clock.nowIso() });
});

module.exports = router;
