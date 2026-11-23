'use strict';
/**
 * ประกอบ Express app
 *
 * ลำดับ middleware:
 *   1) /api/test/* → 404 ถ้าไม่ตั้ง TEST_MODE=1 (ก่อนทุก route จึงปลอดภัยให้บล็อกอื่นประกาศ /api/test/... ในไฟล์ตัวเอง)
 *   2) hooks.onEveryRequest (ยกเว้น /api/test/* และ /static/*) · CONTRACT 0.7
 *   3) session cookie → req.user / req.session
 *   4) body parser JSON/urlencoded (limit 10 MB · multipart ปล่อยให้ multer ของแต่ละ route)
 *   5) GET /api/health · routes/test.js
 *   6) โหลดทุกไฟล์ใน server/routes/*.js อัตโนมัติ (เรียงตามชื่อ) รูปแบบที่รับ:
 *        module.exports = express.Router()             → app.use(router)
 *        module.exports = function (app, ctx) { ... }  → เรียกด้วย app และ ctx
 *        module.exports = { router, path? } หรือ { register(app, ctx) }
 *   7) server/lib/*.js ที่ export install(ctx) จะถูกเรียกตอนเริ่ม (เช่น notify.js ลงทะเบียน hook)
 *   8) fallback: GET / redirect ตามบทบาท · 404 (API = JSON · หน้า = HTML) · error handler
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

const dbm = require('./db');
const clock = require('./lib/clock');
const bug = require('./lib/bugmode');
const pii = require('./lib/pii');
const password = require('./lib/password');
const session = require('./lib/session');
const hooks = require('./lib/hooks');
const format = require('./lib/format');
const htmlLib = require('./lib/html');

const TEST_MODE = process.env.TEST_MODE === '1';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const BODY_LIMIT = '10mb'; // ≥ 6 MB (CONTRACT 0.10)
const CORE_LIBS = new Set(['clock.js', 'bugmode.js', 'pii.js', 'password.js', 'session.js', 'hooks.js', 'format.js', 'html.js', 'reset.js']);

function isTestPath(p) {
  return p === '/api/test' || p.startsWith('/api/test/');
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const ctx = {
    app, db: dbm.db, dbm, clock, bug, isBug: bug.isBug, pii, password, session, hooks, format, html: htmlLib,
    UPLOAD_DIR: dbm.UPLOAD_DIR, DB_PATH: dbm.DB_PATH, BASE_URL, TEST_MODE,
  };
  app.locals.ctx = ctx;

  // 1) ปิด test hook เมื่อไม่ใช่ TEST_MODE
  app.use((req, res, next) => {
    if (isTestPath(req.path) && !TEST_MODE) return res.status(404).json({ code: 'NOT_FOUND', message: 'ไม่พบ' });
    next();
  });

  // 2) ประเมินกฎตามนาฬิกาทุก request (ยกเว้น test hook / static)
  app.use((req, res, next) => {
    if (isTestPath(req.path) || req.path.startsWith('/static/') || req.path === '/favicon.ico') return next();
    try { hooks.runRequest(req); } catch (e) { console.error('[hook] onEveryRequest error:', e); }
    next();
  });

  // 3) session
  app.use(session.middleware);

  // 4) body
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

  // ไม่ cache หน้าที่ขึ้นกับนาฬิกา/สิทธิ์
  app.use((req, res, next) => {
    if (!req.path.startsWith('/static/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // 5) health (ไม่ขึ้นกับ TEST_MODE · ไม่ต้องล็อกอิน · body ตรงตัว)
  app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

  app.use(require('./routes/test'));

  // 6) routes ของบล็อกอื่น
  const routesDir = path.join(__dirname, 'routes');
  for (const f of fs.readdirSync(routesDir).filter((x) => x.endsWith('.js') && x !== 'test.js').sort()) {
    try {
      mount(app, ctx, require(path.join(routesDir, f)), f);
    } catch (e) {
      console.error(`[routes] โหลด ${f} ไม่สำเร็จ:`, e);
      if (process.env.STRICT_LOAD === '1') throw e;
    }
  }

  // 7) lib ที่มี install(ctx)
  const libDir = path.join(__dirname, 'lib');
  for (const f of fs.readdirSync(libDir).filter((x) => x.endsWith('.js') && !CORE_LIBS.has(x)).sort()) {
    try {
      const mod = require(path.join(libDir, f));
      if (mod && typeof mod.install === 'function') mod.install(ctx);
    } catch (e) {
      console.error(`[lib] โหลด ${f} ไม่สำเร็จ:`, e);
      if (process.env.STRICT_LOAD === '1') throw e;
    }
  }

  // 8) fallback
  app.get('/', (req, res) => {
    if (!req.user) return res.redirect(302, '/login');
    if (req.user.role === 'citizen' && (!req.user.registered || (req.session && req.session.scope === 'register'))) {
      return res.redirect(302, '/register');
    }
    res.redirect(302, format.LANDING[req.user.role] || '/login');
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ code: 'NOT_FOUND', message: 'ไม่พบ' });
    res.status(404).type('html').send(htmlLib.basicPage('ไม่พบหน้า',
      htmlLib.html`<h1>ไม่พบหน้าที่ต้องการ</h1><p><a href="/">กลับหน้าแรก</a></p>`));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // ไฟล์ใหญ่เกิน (multer หรือ body parser) → 400 FILE_TOO_LARGE ไม่ใช่ 413 (CONTRACT 0.10)
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large')) {
      return res.status(400).json({ code: 'FILE_TOO_LARGE', message: 'ไฟล์ใหญ่เกิน 5 MB' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ code: 'INVALID_JSON', message: 'รูปแบบข้อมูลไม่ถูกต้อง' });
    }
    const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[error]', req.method, req.path, err);
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ code: (err && err.code) || 'INTERNAL_ERROR', message: (err && err.expose && err.message) || 'เกิดข้อผิดพลาดภายในระบบ' });
    }
    res.status(status).type('html').send(htmlLib.basicPage('เกิดข้อผิดพลาด', htmlLib.html`<h1>เกิดข้อผิดพลาด</h1>`));
  });

  return app;
}

function mount(app, ctx, mod, name) {
  if (!mod) return;
  if (typeof mod === 'function' && Array.isArray(mod.stack)) return void app.use(mod); // express.Router
  if (typeof mod === 'function') return void mod(app, ctx);
  if (typeof mod.register === 'function') return void mod.register(app, ctx);
  if (mod.router) return void app.use(mod.path || '/', mod.router);
  console.warn(`[routes] ${name} ไม่ได้ export router/function · ข้าม`);
}

module.exports = { createApp, TEST_MODE, BASE_URL };
