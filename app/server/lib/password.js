'use strict';
/** รหัสผ่านเจ้าหน้าที่: scrypt · เก็บเป็น "s1.<salt>.<hash>" (base64url) */
const crypto = require('crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32);
  return `s1.${salt.toString('base64url')}.${h.toString('base64url')}`;
}

function verifyPassword(pw, stored) {
  const [v, salt, hash] = String(stored || '').split('.');
  if (v !== 's1' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64url'), want.length);
  return crypto.timingSafeEqual(want, got);
}

module.exports = { hashPassword, verifyPassword };
