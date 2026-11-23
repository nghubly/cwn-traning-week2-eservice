'use strict';
/**
 * เข้ารหัสข้อมูลส่วนบุคคล at rest (NFR-04 · A-55): AES-256-GCM
 * - encrypt(plain) → "v1.<iv>.<tag>.<ct>" (base64url) · decrypt(token) → plain
 * - lookupHash(value) → HMAC-SHA256 แบบ base64url สำหรับค้นหา (เช่น หาผู้ใช้จากเลขบัตร) โดยไม่เก็บค่าจริง
 *
 * ทุกผลลัพธ์เป็น base64url (ไม่ใช่ hex) เพื่อไม่ให้เกิดตัวเลขติดกัน 10–13 หลักในไฟล์ DB โดยบังเอิญ
 * คีย์: PII_KEY (ข้อความใดก็ได้ · แปลงเป็นคีย์ 32 ไบต์ด้วย SHA-256) · ค่าเริ่มต้นเป็นคีย์ทดสอบเท่านั้น
 */
const crypto = require('crypto');

const SECRET = process.env.PII_KEY || 'egov-test-pii-key-not-for-production';
const ENC_KEY = crypto.createHash('sha256').update(`enc:${SECRET}`).digest();
const MAC_KEY = crypto.createHash('sha256').update(`mac:${SECRET}`).digest();

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

function decrypt(token) {
  if (token === null || token === undefined || token === '') return null;
  const [v, iv, tag, ct] = String(token).split('.');
  if (v !== 'v1') throw new Error('pii: unknown token version');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** ค่าค้นหาแบบกำหนดได้ (deterministic) ของข้อมูลอ่อนไหว · ใช้เป็นคอลัมน์ UNIQUE / WHERE */
function lookupHash(value) {
  if (value === null || value === undefined || value === '') return null;
  return crypto.createHmac('sha256', MAC_KEY).update(String(value)).digest('base64url');
}

/** "1101700123456" → "1-1017-00123-45-6" */
function formatIdNo(id) {
  const s = String(id || '');
  if (!/^\d{13}$/.test(s)) return s;
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}

/** "3100600987659" → "X-XXXX-XXXXX-65-9" (เก็บใน DB ได้ ไม่มีตัวเลขติดกันเกิน 2 หลัก) */
function maskIdNo(id) {
  const s = String(id || '');
  if (!/^\d{13}$/.test(s)) return 'X-XXXX-XXXXX-XX-X';
  return `X-XXXX-XXXXX-${s.slice(10, 12)}-${s[12]}`;
}

/** "สมชาย ใจดี" → "สมชาย ใ***" (A-54) */
function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  const last = parts.pop();
  return `${parts.join(' ')} ${Array.from(last)[0]}***`;
}

module.exports = { encrypt, decrypt, lookupHash, formatIdNo, maskIdNo, maskName };
