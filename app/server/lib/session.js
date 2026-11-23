'use strict';
/**
 * session cookie (HttpOnly) เก็บในตาราง sessions · reset ลบทั้งตาราง → ทุกคนต้องล็อกอินใหม่
 *
 * ใช้ใน route:
 *   const session = require('../lib/session');
 *   session.create(res, user.id, { scope: 'full' });   // หลังล็อกอิน (citizen ยังไม่ลงทะเบียน: scope 'register')
 *   session.destroy(req, res);                         // logout
 *   req.user    → แถว users ของผู้ล็อกอิน (หรือ null) · middleware ตั้งให้ทุก request
 *   req.session → { sid, scope, data } (หรือ null)
 *   session.setData(req, { ... })                      // เก็บ JSON เล็ก ๆ (ห้ามใส่เลขบัตร/เบอร์)
 */
const crypto = require('crypto');
const { db } = require('../db');
const clock = require('./clock');

const COOKIE = 'sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function cookieOpts() {
  return { httpOnly: true, sameSite: 'lax', path: '/' };
}

function create(res, userId, { scope = 'full', data = {} } = {}) {
  const sid = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions(sid, user_id, scope, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sid, userId, scope, JSON.stringify(data), clock.nowIso());
  res.cookie(COOKIE, sid, cookieOpts());
  return sid;
}

function destroy(req, res) {
  const sid = req.session && req.session.sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  res.clearCookie(COOKIE, cookieOpts());
  req.session = null;
  req.user = null;
}

/** ลบทุก session ของผู้ใช้ (เช่น admin เปลี่ยนบทบาท ถ้าต้องการบังคับล็อกอินใหม่) */
function destroyUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function setData(req, patch) {
  if (!req.session) return;
  req.session.data = { ...req.session.data, ...patch };
  db.prepare('UPDATE sessions SET data = ? WHERE sid = ?').run(JSON.stringify(req.session.data), req.session.sid);
}

/** ยกระดับ scope (เช่น register → full หลังลงทะเบียนเสร็จ) */
function setScope(req, scope) {
  if (!req.session) return;
  db.prepare('UPDATE sessions SET scope = ? WHERE sid = ?').run(scope, req.session.sid);
  req.session.scope = scope;
}

/** middleware: โหลด req.session / req.user จาก cookie */
function middleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.session = null;
  req.user = null;
  const sid = req.cookies[COOKIE];
  if (sid) {
    const row = db.prepare(
      'SELECT s.sid, s.scope, s.data, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ? AND u.active = 1',
    ).get(sid);
    if (row) {
      const { sid: s, scope, data, ...user } = row;
      let parsed = {};
      try { parsed = JSON.parse(data || '{}'); } catch { /* ignore */ }
      req.session = { sid: s, scope, data: parsed };
      req.user = user;
    }
  }
  next();
}

module.exports = { COOKIE, parseCookies, create, destroy, destroyUser, setData, setScope, middleware };
