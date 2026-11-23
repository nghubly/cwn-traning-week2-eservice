'use strict';
/**
 * B11 · Audit Trail + หน้าผู้ดูแลระบบ
 * REQUIREMENTS BR-27 BR-28 · CONTRACT §2.10 §2.11 §5 §6.4 §6.5 §6.8 · DECISIONS §3 §13
 *
 * ส่วนที่บล็อกอื่นเรียกใช้:
 *   const audit = require('./audit-admin');
 *   audit.log({ username, role, event, caseNo, fromStatus, toStatus, detail })
 *   audit.logFor(req.user, 'EXPORT', { detail: 'audit-csv' })
 */
const express = require('express');
const { db } = require('../db');
const auth = require('./auth');
const { html, raw, esc } = require('../lib/html');

const EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];
const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const DEPTS = ['registry', 'works'];
const SERVICE_IDS = ['SV-01', 'SV-02', 'SV-03'];

const MSG = {
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
};

// ───────────── helper สำหรับบล็อกอื่น ─────────────
function log(entry) { return auth.audit(entry); }
function logFor(user, event, rest) { return auth.auditFor(user, event, rest); }

// ───────────── query audit ─────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function queryAudit(q) {
  const where = [];
  const args = [];
  const actor = String(q.actor || '').trim();
  const event = String(q.event || '').trim();
  const from = String(q.from || '').trim();
  const to = String(q.to || '').trim();
  if (actor) { where.push('username = ?'); args.push(actor); }
  if (event) { where.push('event = ?'); args.push(event); }
  // เวลาเก็บเป็น ISO +07:00 → 10 ตัวแรกคือวันที่ตามเวลาไทย · รวมวันเริ่มและวันจบ
  if (DATE_RE.test(from)) { where.push('substr(time, 1, 10) >= ?'); args.push(from); }
  if (DATE_RE.test(to)) { where.push('substr(time, 1, 10) <= ?'); args.push(to); }
  const sql = 'SELECT id, time, username, role, event, case_no, from_status, to_status, detail FROM audit_log' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY time DESC, id DESC';
  return db.prepare(sql).all(...args).map((r) => ({
    id: r.id, time: r.time, username: r.username, role: r.role, event: r.event,
    caseNo: r.case_no, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail || '',
  }));
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(items) {
  const lines = ['time,username,role,event,caseNo,fromStatus,toStatus,detail'];
  for (const r of items) {
    lines.push([r.time, r.username, r.role, r.event, r.caseNo, r.fromStatus, r.toStatus, r.detail].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function qs(q) {
  const p = new URLSearchParams();
  for (const k of ['actor', 'event', 'from', 'to']) if (q[k]) p.set(k, String(q[k]));
  const s = p.toString();
  return s ? '?' + s : '';
}

// ───────────── หน้า /audit ─────────────
function auditPage(req, res) {
  const q = req.query || {};
  const items = queryAudit(q);
  const rows = items.map((r) => html`<tr data-testid="audit-row" data-id="${r.id}" data-event="${r.event}" data-actor="${r.username || ''}" data-case-no="${r.caseNo || ''}">
<td data-testid="audit-time" data-iso="${r.time}">${r.time}</td>
<td data-testid="audit-actor">${r.username || ''}</td>
<td data-testid="audit-role">${r.role || ''}</td>
<td data-testid="audit-event">${r.event}</td>
<td data-testid="audit-case-no">${r.caseNo || ''}</td>
<td data-testid="audit-transition">${r.fromStatus || r.toStatus ? `${r.fromStatus || '–'} → ${r.toStatus || '–'}` : '–'}</td>
<td data-testid="audit-detail">${r.detail}</td></tr>`);
  const opts = [html`<option value="">ทั้งหมด</option>`].concat(EVENTS.map((e) => html`<option value="${e}"${q.event === e ? raw(' selected') : ''}>${e}</option>`));
  const body = html`<h1>Audit Trail</h1>
<form method="get" action="/audit" class="card" style="max-width:none">
<div class="field"><label for="f-actor">ผู้ทำ (username)</label><input id="f-actor" name="actor" type="text" data-testid="audit-filter-actor" value="${q.actor || ''}"></div>
<div class="field"><label for="f-event">เหตุการณ์</label><select id="f-event" name="event" data-testid="audit-filter-event">${opts}</select></div>
<div class="field"><label for="f-from">ตั้งแต่วันที่</label><input id="f-from" name="from" type="date" data-testid="audit-filter-from" value="${q.from || ''}"></div>
<div class="field"><label for="f-to">ถึงวันที่</label><input id="f-to" name="to" type="date" data-testid="audit-filter-to" value="${q.to || ''}"></div>
<button type="submit" data-testid="audit-apply-btn">ค้นหา</button>
<a href="/api/audit/export.csv${qs(q)}" data-testid="audit-export-csv-btn" download="audit.csv" role="button">ส่งออก CSV</a>
</form>
<p>จำนวนรายการ: <span data-testid="audit-count">${items.length}</span></p>
<div style="overflow-x:auto"><table>
<caption>รายการ Audit Trail (ใหม่ → เก่า)</caption>
<thead><tr><th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th><th scope="col">เลขคำขอ</th><th scope="col">สถานะ</th><th scope="col">รายละเอียด</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
  return auth.sendPage(req, res, { title: 'Audit Trail', body });
}

// ───────────── ตรวจค่า ─────────────
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}
const validFee = (v) => { const n = toInt(v); return n !== null && n >= 0 && n <= 100000 ? n : null; };
const validSla = (v) => { const n = toInt(v); return n !== null && n >= 1 && n <= 60 ? n : null; };
const has = (b, k) => b && b[k] !== undefined && b[k] !== null;

function serviceItems() {
  return db.prepare('SELECT id, fee, fee_base, fee_per_sqm, sla FROM services ORDER BY sort, id').all().map((s) => ({
    id: s.id,
    fee: s.id === 'SV-03' ? s.fee_base : s.fee,
    feeBase: s.fee_base,
    feePerSqm: s.fee_per_sqm,
    sla: s.sla,
  }));
}

/** ผลคือ {status, code, message} หรือ {ok:true, changes:[...]} */
function updateService(id, body, user) {
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!svc) return { status: 404, code: 'NOT_FOUND', message: 'ไม่พบบริการ' };
  body = body || {};
  const sets = {};
  const changes = [];
  const isSqm = id === 'SV-03';
  const feeKey = isSqm ? 'fee_base' : 'fee';
  const feeIn = has(body, isSqm ? 'feeBase' : 'fee') ? (isSqm ? body.feeBase : body.fee) : (has(body, 'fee') ? body.fee : undefined);
  if (feeIn !== undefined) {
    const n = validFee(feeIn);
    if (n === null) return { status: 400, code: 'INVALID_FEE', message: MSG.INVALID_FEE };
    sets[feeKey] = n;
  }
  if (isSqm && has(body, 'feePerSqm')) {
    const n = validFee(body.feePerSqm);
    if (n === null) return { status: 400, code: 'INVALID_FEE', message: MSG.INVALID_FEE };
    sets.fee_per_sqm = n;
  }
  if (has(body, 'sla')) {
    const n = validSla(body.sla);
    if (n === null) return { status: 400, code: 'INVALID_SLA', message: MSG.INVALID_SLA };
    sets.sla = n;
  }
  const label = { fee: 'fee', fee_base: 'fee', fee_per_sqm: 'feePerSqm', sla: 'sla' };
  for (const k of Object.keys(sets)) {
    if (svc[k] !== sets[k]) changes.push(`${id} ${label[k]} ${svc[k]} → ${sets[k]}`);
  }
  db.transaction(() => {
    for (const k of Object.keys(sets)) db.prepare(`UPDATE services SET ${k} = ? WHERE id = ?`).run(sets[k], id);
    for (const c of changes) logFor(user, 'ADMIN_CHANGE', { detail: c });
  })();
  return { ok: true, changes };
}

// ───────────── หน้า admin ─────────────
const FLASH_SCRIPT = raw(`<script>
(function(){
  function flash(kind, text){
    var old=document.querySelectorAll('[data-testid="action-error"],[data-testid="action-success"]');
    old.forEach(function(e){e.remove();});
    var d=document.createElement('div');
    d.setAttribute('data-testid', kind==='error'?'action-error':'action-success');
    d.setAttribute('role', kind==='error'?'alert':'status');
    d.className=kind==='error'?'error':'success';
    d.textContent=text;
    var m=document.getElementById('main')||document.body;
    m.insertBefore(d,m.firstChild);
  }
  window.adminCall=function(method,url,body,okMsg,reload){
    return fetch(url,{method:method,headers:{'Content-Type':'application/json'},credentials:'same-origin',body:body?JSON.stringify(body):undefined})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){
        if(!r.ok){flash('error',j.message||'ทำรายการไม่สำเร็จ');return false;}
        if(reload){try{sessionStorage.setItem('adminFlash',okMsg);}catch(e){} location.reload();return true;}
        flash('success',okMsg);return true;});});
  };
  try{var m=sessionStorage.getItem('adminFlash');if(m){sessionStorage.removeItem('adminFlash');flash('success',m);}}catch(e){}
})();
</script>`);

function servicesPage(req, res) {
  const items = serviceItems();
  const rows = items.map((s) => {
    const id = s.id;
    const sqm = id === 'SV-03';
    const name = db.prepare('SELECT name FROM services WHERE id = ?').get(id).name;
    return html`<tr data-testid="service-row" data-service-id="${id}">
<th scope="row">${id} ${name}</th>
<td><label for="fee-${id}">${sqm ? 'ค่าธรรมเนียมฐาน (฿)' : 'ค่าธรรมเนียม (฿)'}<span class="sr-only"> ${id}</span></label>
<input id="fee-${id}" type="number" step="1" data-testid="svc-fee-${id}" value="${sqm ? s.feeBase : s.fee}"></td>
<td>${sqm ? html`<label for="sqm-${id}">฿ ต่อ ตร.ม. ส่วนเกิน 100</label><input id="sqm-${id}" type="number" step="1" data-testid="svc-fee-per-sqm-${id}" value="${s.feePerSqm}">` : ''}</td>
<td><label for="sla-${id}">SLA (วันทำการ) <span class="sr-only">${id}</span></label>
<input id="sla-${id}" type="number" step="1" data-testid="svc-sla-${id}" value="${s.sla}"></td>
<td><button type="button" data-testid="svc-save-${id}" data-sid="${id}" data-sqm="${sqm ? '1' : ''}" class="svc-save">บันทึก ${id}</button></td></tr>`;
  });
  const body = html`<h1>จัดการบริการ</h1>
<div style="overflow-x:auto"><table><caption>ค่าธรรมเนียมและ SLA ของบริการ</caption>
<thead><tr><th scope="col">บริการ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">ต่อ ตร.ม.</th><th scope="col">SLA</th><th scope="col">บันทึก</th></tr></thead>
<tbody>${rows}</tbody></table></div>
${FLASH_SCRIPT}
<script>
document.querySelectorAll('.svc-save').forEach(function(b){
  b.addEventListener('click',function(){
    var id=b.getAttribute('data-sid');
    var f=document.querySelector('[data-testid="svc-fee-'+id+'"]').value;
    var s=document.querySelector('[data-testid="svc-sla-'+id+'"]').value;
    var body={sla:s};
    if(b.getAttribute('data-sqm')){body.feeBase=f;body.feePerSqm=document.querySelector('[data-testid="svc-fee-per-sqm-'+id+'"]').value;}
    else body.fee=f;
    window.adminCall('PUT','/api/admin/services/'+id,body,'บันทึกแล้ว',false);
  });
});
</script>`;
  return auth.sendPage(req, res, { title: 'จัดการบริการ', body });
}

function holidaysPage(req, res) {
  const rows = db.prepare('SELECT date, name FROM holidays ORDER BY date').all().map((h) => html`<tr data-testid="holiday-row" data-date="${h.date}">
<td>${h.date}</td><td>${h.name}</td>
<td><button type="button" data-testid="holiday-delete-btn" class="hol-del" data-date="${h.date}">ลบ <span class="sr-only">${h.date}</span></button></td></tr>`);
  const body = html`<h1>จัดการวันหยุด</h1>
<div class="card">
<div class="field"><label for="h-date">วันที่ (YYYY-MM-DD ค.ศ.)</label><input id="h-date" type="text" inputmode="numeric" placeholder="2026-12-02" data-testid="holiday-date-input"></div>
<div class="field"><label for="h-name">ชื่อวันหยุด</label><input id="h-name" type="text" data-testid="holiday-name-input"></div>
<button type="button" id="h-add" data-testid="holiday-add-btn">เพิ่มวันหยุด</button>
</div>
<div style="overflow-x:auto"><table><caption>รายการวันหยุด</caption>
<thead><tr><th scope="col">วันที่</th><th scope="col">ชื่อ</th><th scope="col">จัดการ</th></tr></thead>
<tbody>${rows}</tbody></table></div>
${FLASH_SCRIPT}
<script>
document.getElementById('h-add').addEventListener('click',function(){
  window.adminCall('POST','/api/admin/holidays',{date:document.getElementById('h-date').value.trim(),name:document.getElementById('h-name').value.trim()},'เพิ่มวันหยุดแล้ว',true);
});
document.querySelectorAll('.hol-del').forEach(function(b){
  b.addEventListener('click',function(){
    window.adminCall('DELETE','/api/admin/holidays/'+encodeURIComponent(b.getAttribute('data-date')),null,'ลบวันหยุดแล้ว',true);
  });
});
</script>`;
  return auth.sendPage(req, res, { title: 'จัดการวันหยุด', body });
}

const ROLE_LABEL = { citizen: 'ประชาชน', officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย', executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ' };
const DEPT_LABEL = { '': '(ไม่มี)', registry: 'ทะเบียน', works: 'โยธา' };

function userRows() {
  return db.prepare("SELECT username, name, role, dept FROM users WHERE username IS NOT NULL AND username <> '' ORDER BY id").all();
}

function usersPage(req, res) {
  const rows = userRows().map((u) => html`<tr data-testid="user-row" data-username="${u.username}">
<td>${u.username}</td><td>${u.name}</td>
<td><label for="role-${u.username}">บทบาท <span class="sr-only">${u.username}</span></label>
<select id="role-${u.username}" data-testid="user-role-select">${ROLES.map((r) => html`<option value="${r}"${u.role === r ? raw(' selected') : ''}>${r}</option>`)}</select></td>
<td><label for="dept-${u.username}">แผนก <span class="sr-only">${u.username}</span></label>
<select id="dept-${u.username}" data-testid="user-dept-select">${['', ...DEPTS].map((d) => html`<option value="${d}"${(u.dept || '') === d ? raw(' selected') : ''}>${DEPT_LABEL[d]}</option>`)}</select></td>
<td><button type="button" data-testid="user-save-btn" class="u-save" data-username="${u.username}">บันทึก <span class="sr-only">${u.username}</span></button></td></tr>`);
  const body = html`<h1>จัดการผู้ใช้และบทบาท</h1>
<div style="overflow-x:auto"><table><caption>ผู้ใช้ภายในระบบ</caption>
<thead><tr><th scope="col">username</th><th scope="col">ชื่อ</th><th scope="col">บทบาท</th><th scope="col">แผนก</th><th scope="col">บันทึก</th></tr></thead>
<tbody>${rows}</tbody></table></div>
${FLASH_SCRIPT}
<script>
document.querySelectorAll('.u-save').forEach(function(b){
  b.addEventListener('click',function(){
    var tr=b.closest('tr');
    window.adminCall('PUT','/api/admin/users/'+encodeURIComponent(b.getAttribute('data-username')),
      {role:tr.querySelector('[data-testid="user-role-select"]').value,dept:tr.querySelector('[data-testid="user-dept-select"]').value},'บันทึกแล้ว',false);
  });
});
</script>`;
  return auth.sendPage(req, res, { title: 'จัดการผู้ใช้', body });
}

// ───────────── register ─────────────
function register(app) {
  const r = express.Router();
  const notAllowed = (req, res) => auth.apiError(res, 405, 'METHOD_NOT_ALLOWED', MSG.METHOD_NOT_ALLOWED);
  const err = (res, e) => auth.apiError(res, e.status, e.code, e.message);

  // Audit: เพิ่มได้อย่างเดียว · แก้/ลบ → 405 ทุกบทบาท (แม้ id ไม่มีจริง)
  r.all(['/api/audit', '/api/audit/:id'], (req, res, next) => {
    if (['PUT', 'PATCH', 'DELETE', 'POST'].includes(req.method)) return notAllowed(req, res);
    next();
  });

  r.get('/audit', auth.requirePage('auditor'), auditPage);

  r.get('/api/audit', auth.requireApi('auditor'), (req, res) => {
    const items = queryAudit(req.query || {});
    res.json({ count: items.length, items });
  });

  r.get('/api/audit/export.csv', auth.requireApi('auditor'), (req, res) => {
    const items = queryAudit(req.query || {});
    logFor(req.user, 'EXPORT', { detail: 'audit-csv' });
    res.status(200)
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="audit.csv"')
      .send(toCsv(items));
  });

  // หน้า admin
  r.get('/admin', auth.requirePage('admin'), (req, res) => res.redirect(302, '/admin/services'));
  r.get('/admin/services', auth.requirePage('admin'), servicesPage);
  r.get('/admin/holidays', auth.requirePage('admin'), holidaysPage);
  r.get('/admin/users', auth.requirePage('admin'), usersPage);

  // API: services
  r.get('/api/admin/services', auth.requireApi('admin'), (req, res) => res.json({ items: serviceItems() }));
  r.put('/api/admin/services/:id', auth.requireApi('admin'), (req, res) => {
    const out = updateService(req.params.id, req.body, req.user);
    if (!out.ok) return err(res, out);
    res.json({ ok: true, items: serviceItems(), item: serviceItems().find((s) => s.id === req.params.id) });
  });

  // API: holidays
  r.get('/api/admin/holidays', auth.requireApi('admin'), (req, res) => {
    res.json({ items: db.prepare('SELECT date, name FROM holidays ORDER BY date').all() });
  });
  r.post('/api/admin/holidays', auth.requireApi('admin'), (req, res) => {
    const date = req.body && typeof req.body.date === 'string' ? req.body.date.trim() : '';
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const okDate = DATE_RE.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z')) &&
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
    if (!okDate) return auth.apiError(res, 400, 'INVALID_DATE', 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
    if (db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date)) {
      return auth.apiError(res, 409, 'DUPLICATE_HOLIDAY', MSG.DUPLICATE_HOLIDAY);
    }
    const clock = require('../lib/clock');
    db.transaction(() => {
      db.prepare('INSERT INTO holidays(date, name, created_at) VALUES (?, ?, ?)').run(date, name || 'วันหยุด', clock.nowIso());
      logFor(req.user, 'ADMIN_CHANGE', { detail: `holiday add ${date}` });
    })();
    res.status(201).json({ ok: true, date, name: name || 'วันหยุด' });
  });
  r.delete('/api/admin/holidays/:date', auth.requireApi('admin'), (req, res) => {
    const date = req.params.date;
    if (!db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date)) {
      return auth.apiError(res, 404, 'NOT_FOUND', 'ไม่พบวันหยุดนี้');
    }
    db.transaction(() => {
      db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
      logFor(req.user, 'ADMIN_CHANGE', { detail: `holiday delete ${date}` });
    })();
    res.json({ ok: true });
  });

  // API: users
  r.get('/api/admin/users', auth.requireApi('admin'), (req, res) => {
    res.json({ items: userRows().map((u) => ({ username: u.username, name: u.name, role: u.role, dept: u.dept || '' })) });
  });
  r.put('/api/admin/users/:username', auth.requireApi('admin'), (req, res) => {
    const username = req.params.username;
    const b = req.body || {};
    if (req.user.username === username && b.role !== undefined) {
      return auth.apiError(res, 409, 'SELF_ROLE_CHANGE', MSG.SELF_ROLE_CHANGE);
    }
    const u = db.prepare('SELECT id, username, role, dept FROM users WHERE username = ?').get(username);
    if (!u) return auth.apiError(res, 404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
    const role = b.role !== undefined ? b.role : u.role;
    if (!ROLES.includes(role)) return auth.apiError(res, 400, 'INVALID_ROLE', 'บทบาทไม่ถูกต้อง');
    let dept = b.dept !== undefined && b.dept !== null ? String(b.dept) : (u.dept || '');
    if (dept && !DEPTS.includes(dept)) return auth.apiError(res, 400, 'INVALID_DEPT', 'แผนกไม่ถูกต้อง');
    if (role !== 'officer' && b.dept === undefined) dept = '';
    db.transaction(() => {
      db.prepare('UPDATE users SET role = ?, dept = ? WHERE id = ?').run(role, dept, u.id);
      if (role !== u.role) logFor(req.user, 'ADMIN_CHANGE', { detail: `${username} role ${u.role} → ${role}` });
      if (dept !== (u.dept || '')) logFor(req.user, 'ADMIN_CHANGE', { detail: `${username} dept ${u.dept || '-'} → ${dept || '-'}` });
    })();
    res.json({ ok: true, username, role, dept });
  });

  app.use(r);
}

module.exports = register;
Object.assign(module.exports, { log, logFor, queryAudit, toCsv, EVENTS, MSG });
