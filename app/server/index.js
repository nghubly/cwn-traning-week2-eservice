'use strict';
/** จุดเริ่มระบบ: node server/index.js */
const { createApp, TEST_MODE } = require('./app');
const { ensureSeeded } = require('./lib/reset');
const bug = require('./lib/bugmode');
const clock = require('./lib/clock');
const { DB_PATH } = require('./db');

const PORT = Number(process.env.PORT || 3000);

const app = createApp();
try {
  if (ensureSeeded()) console.log('[boot] ฐานข้อมูลยังไม่เคย reset → reset + seed ครั้งแรกแล้ว');
} catch (e) {
  console.error('[boot] seed ไม่สำเร็จ:', e);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] e-Service เทศบาลนครสุขใจ (ระบบจำลอง) ฟังที่พอร์ต ${PORT}`);
  console.log(`[boot] TEST_MODE=${TEST_MODE ? '1' : 'ปิด'} · BUG_MODE=${bug.list().join(',') || 'ไม่มี'} · DB_PATH=${DB_PATH} · now=${clock.nowIso()}`);
});
server.requestTimeout = 120000;

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
