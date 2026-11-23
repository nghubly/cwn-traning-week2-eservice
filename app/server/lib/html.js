'use strict';
/**
 * HTML ขั้นต่ำ (escape + โครงหน้าเปล่า) · layout จริงพร้อม header/nav ตามบทบาทเป็นของบล็อก auth (B03)
 * ใช้ tagged template: html`<p>${userText}</p>` → escape อัตโนมัติ · raw(str) เพื่อไม่ escape
 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

class Raw { constructor(s) { this.s = String(s); } toString() { return this.s; } }
const raw = (s) => new Raw(s);

function render(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}

function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return raw(out);
}

/** หน้าเปล่าขั้นต่ำ (ใช้กับ 404/ข้อผิดพลาดของโครง) */
function basicPage(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)} · e-Service เทศบาลนครสุขใจ</title><link rel="stylesheet" href="/static/app.css"></head>` +
    `<body><main id="main">${render(body)}</main></body></html>`;
}

module.exports = { esc, raw, html, render, basicPage };
