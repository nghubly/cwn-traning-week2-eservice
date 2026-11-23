/**
 * helpers-b.ts · ตัวช่วยของชุด B (TC-WORKFLOW … TC-NFR) ตาม TEST-PLAN §0
 * ค่าคาดหวังทั้งหมดอยู่ใน part-b.spec.ts (คิดจาก TEST-PLAN / TEST-DATA / CONTRACT ไม่ได้อ่านจากเว็บ)
 *
 * หลักสำคัญ (CONTRACT 0.9): reset ล้าง session ของทุกคน → reset() ปิดทุก context ที่เปิดไว้ก่อน
 * แล้วผู้เรียกต้องสร้าง actor ใหม่ (ล็อกอินใหม่) ทุกครั้ง
 * actor = BrowserContext 1 ตัว → page (UI) และ ctx.request (API) ใช้ cookie ร่วมกัน
 */
import {
  expect,
  request as pwRequest,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recordVideoOpts } from './video';
import * as zlib from 'node:zlib';

// ───────────────────────── ค่าคงที่ ─────────────────────────

export const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const T0 = '2026-12-01T09:00:00+07:00';
export const PASSWORD = 'Test@1234';
export const OTP = '123456';

export const ID = {
  somchai: '1101700123456',
  somying: '3100600987659',
  mana: '5500400111221',
  piti: '1909900555015',
} as const;

/** ค่าที่ต้องไม่หลุดออกไป (เลขบัตร/รูปแบบมีขีด/เบอร์) */
export const PII_IDS = ['1101700123456', '3100600987659', '1909900555015', '5500400111221'];
export const PII_IDS_DASHED = ['1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1'];
export const PII_MOBILES = ['0812345678', '0823456789', '0834567890', '0845678901'];
export const APPLICANT_FIRST_NAMES = ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ'];

export const MASKED_RE = /^X-XXXX-XXXXX-\d{2}-\d$/;
export const VERIFY_CODE_RE = /^[A-Z0-9]{8}$/;

/** `…000025` → `EG-2569-000025` */
export const cn = (n: number, year = 2569) => `EG-${year}-${String(n).padStart(6, '0')}`;

/** CONTRACT 4.1 */
export const STATUS_TH: Record<string, string> = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
};

/** CONTRACT 4.2 */
export const LEVEL_TH: Record<string, string> = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

/** CONTRACT 5 (ตรงตัวอักษร) */
export const MSG = {
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  NOT_FOUND: 'ไม่พบคำขอ',
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
  NO_REFUND: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
} as const;

/** เอกสารบังคับของ NEW_PAID (TEST-PLAN §0 · TEST-DATA ข้อ 11) */
export const REQUIRED_DOCS: Record<string, [docKey: string, name: string][]> = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [['id-card', 'id-card.pdf'], ['map', 'map.pdf']],
  'SV-03': [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']],
};

// ───────────────────────── ไฟล์ทดสอบ (TEST-DATA ข้อ 11) ─────────────────────────

/** PDF จริงขนาด n ไบต์ (หัว %PDF + เติมช่องว่าง + %%EOF) · ตรงกับ make_testfiles.py */
export function pdf(n = 1024): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error('pdf too small');
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

export const pdfFile = (name: string, n = 1024) => ({ name, mimeType: 'application/pdf', buffer: pdf(n) });

// ───────────────────────── context / actor ─────────────────────────

const openContexts = new Set<BrowserContext>();
const openRequests = new Set<APIRequestContext>();

export interface Actor {
  name: string;
  ctx: BrowserContext;
  page: Page;
  /** API ที่ใช้ cookie เดียวกับ page */
  api: APIRequestContext;
}

export interface ActorOpts {
  viewport?: { width: number; height: number };
}

/** ปิดทุก context/request ที่ helper เปิดไว้ (เรียกใน afterEach และก่อน reset) */
export async function closeAll(): Promise<void> {
  for (const c of openContexts) await c.close().catch(() => undefined);
  for (const r of openRequests) await r.dispose().catch(() => undefined);
  openContexts.clear();
  openRequests.clear();
}

/** request context ใหม่ไม่มี cookie (ใช้กับ test hook และการเรียกแบบไม่ล็อกอิน) */
export async function rawApi(): Promise<APIRequestContext> {
  const r = await pwRequest.newContext({ baseURL: BASE_URL });
  openRequests.add(r);
  return r;
}

async function newActor(browser: Browser, name: string, opts: ActorOpts = {}): Promise<Actor> {
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    acceptDownloads: true,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    ...recordVideoOpts(),
  });
  openContexts.add(ctx);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => undefined)); // กล่องยืนยัน (ถ้ามี) กดตกลง
  return { name, ctx, page, api: ctx.request };
}

/** ผู้ใช้ไม่ล็อกอิน (context ใหม่ ไม่มี cookie) */
export const asAnon = (browser: Browser, opts?: ActorOpts) => newActor(browser, 'anon', opts);

/** LOGIN_S(user) */
export async function asStaff(browser: Browser, username: string, opts?: ActorOpts): Promise<Actor> {
  const a = await newActor(browser, username, opts);
  const res = await a.api.post('/api/auth/staff/login', { data: { username, password: PASSWORD } });
  expect(res.status(), `LOGIN_S ${username}`).toBe(200);
  return a;
}

/** LOGIN_C(เลขบัตร) · expectRegistered=false สำหรับมานะ (ยังไม่ลงทะเบียน) */
export async function asCitizen(
  browser: Browser,
  idNo: string,
  opts: ActorOpts & { expectRegistered?: boolean } = {},
): Promise<Actor> {
  const a = await newActor(browser, idNo, opts);
  const s = await a.api.post('/api/auth/thaid/start', { data: { idNo } });
  expect(s.status(), `thaid/start ${idNo}`).toBe(200);
  const v = await a.api.post('/api/auth/thaid/verify', { data: { idNo, otp: OTP } });
  expect(v.status(), `thaid/verify ${idNo}`).toBe(200);
  const j = await v.json();
  expect(j.registered, `registered ${idNo}`).toBe(opts.expectRegistered ?? true);
  return a;
}

// ───────────────────────── test hooks ─────────────────────────

/** RESET (ปิด context เก่าทั้งหมดก่อน เพราะ session ใช้ไม่ได้แล้ว) */
export async function reset(): Promise<void> {
  await closeAll();
  const r = await rawApi();
  const res = await r.post('/api/test/reset');
  expect(res.status(), 'POST /api/test/reset').toBe(200);
  const j = await res.json();
  expect(j.now, 'reset now').toBe(T0);
}

/** CLOCK(t) */
export async function setClock(now: string): Promise<void> {
  const r = await rawApi();
  const res = await r.put('/api/test/clock', { data: { now } });
  expect(res.status(), `PUT /api/test/clock ${now}`).toBe(200);
}

/** NEW_PAID (ผู้เรียกตั้ง CLOCK และล็อกอินก่อน) */
export async function newPaid(
  api: APIRequestContext,
  serviceId: 'SV-01' | 'SV-02' | 'SV-03',
  opts: { qty?: number; areaSqm?: number } = {},
): Promise<{ draftId: string; ref: string; amount: number; caseNo: string }> {
  const body: Record<string, unknown> = { serviceId };
  if (serviceId === 'SV-01') body.qty = opts.qty ?? 1;
  if (serviceId === 'SV-03') body.areaSqm = opts.areaSqm ?? 80;
  const d = await api.post('/api/drafts', { data: body });
  expect(d.status(), 'POST /api/drafts').toBe(201);
  const { draftId, fee } = await d.json();
  for (const [docKey, name] of REQUIRED_DOCS[serviceId]) {
    const f = await api.post(`/api/drafts/${draftId}/files`, { multipart: { docKey, file: pdfFile(name) } });
    expect(f.status(), `upload ${name}`).toBe(201);
  }
  const p = await api.post(`/api/drafts/${draftId}/payment`);
  expect(p.status(), 'POST payment').toBe(201);
  const pj = await p.json();
  const amount = pj.amount ?? fee;
  const pay = await api.post(`/api/test/payments/${pj.ref}/pay`, { data: { amount } });
  expect(pay.status(), `pay ${pj.ref}`).toBe(200);
  const g = await api.get(`/api/payments/${pj.ref}`);
  expect(g.status()).toBe(200);
  const gj = await g.json();
  expect(gj.status).toBe('PAID');
  return { draftId, ref: pj.ref, amount, caseNo: gj.caseNo };
}

// ───────────────────────── API assert ─────────────────────────

export async function json(res: APIResponse): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** ตรวจ HTTP status (+ code/message ของ `{"code","message"}` ถ้าให้มา) */
export async function expectApi(
  res: APIResponse,
  status: number,
  code?: string,
  message?: string,
): Promise<any> {
  const body = await json(res);
  expect(res.status(), `${res.url()} → ${JSON.stringify(body)}`).toBe(status);
  if (code !== undefined) expect(body?.code, `code of ${res.url()}`).toBe(code);
  if (message !== undefined) expect(body?.message, `message of ${res.url()}`).toBe(message);
  return body;
}

export async function getCase(api: APIRequestContext, caseNo: string): Promise<any> {
  const r = await api.get(`/api/cases/${caseNo}`);
  expect(r.status(), `GET /api/cases/${caseNo}`).toBe(200);
  return r.json();
}

export async function dashApi(api: APIRequestContext, period: string, service = 'ALL'): Promise<any> {
  const r = await api.get(`/api/dashboard?period=${period}&service=${service}`);
  expect(r.status(), `GET /api/dashboard ${period} ${service}`).toBe(200);
  return r.json();
}

export async function auditApi(api: APIRequestContext, q: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(q).toString();
  const r = await api.get(`/api/audit${qs ? `?${qs}` : ''}`);
  expect(r.status(), `GET /api/audit?${qs}`).toBe(200);
  return r.json();
}

/** หาค่า key ทุกชั้นใน object (ใช้ตรวจว่าไม่มี key `idNo`) */
export function findKeysDeep(obj: unknown, key: string, at = '$'): string[] {
  const out: string[] = [];
  if (Array.isArray(obj)) obj.forEach((v, i) => out.push(...findKeysDeep(v, key, `${at}[${i}]`)));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === key) out.push(`${at}.${k}`);
      out.push(...findKeysDeep(v, key, `${at}.${k}`));
    }
  }
  return out;
}

/** ตรวจข้อความที่ดึงออกมาว่าไม่มีข้อมูลส่วนบุคคล (BR-24): \d{13} · 0\d{9} · ชื่อผู้ยื่น */
export function expectNoPII(text: string, label: string): void {
  expect.soft(text, `${label}: ไม่มีเลข 13 หลัก`).not.toMatch(/\d{13}/);
  expect.soft(text, `${label}: ไม่มีเบอร์ 0\\d{9}`).not.toMatch(/0\d{9}/);
  for (const n of APPLICANT_FIRST_NAMES) expect.soft(text, `${label}: ไม่มีชื่อ ${n}`).not.toContain(n);
}

// ───────────────────────── UI helpers ─────────────────────────

export const tid = (scope: Page | Locator, id: string): Locator => scope.getByTestId(id);

/** ตรวจ `case-status` ทั้งข้อความไทยและ data-status */
export async function expectStatus(page: Page, code: string): Promise<void> {
  const l = tid(page, 'case-status');
  await expect(l, `case-status = ${code}`).toHaveAttribute('data-status', code);
  await expect(l).toHaveText(STATUS_TH[code]);
}

export async function expectCount(scope: Page | Locator, id: string, n: number): Promise<void> {
  await expect(tid(scope, id), `${id} count`).toHaveCount(n);
}

/** เปิดหน้าแล้วคืน HTTP status ของ response สุดท้าย */
export async function open(page: Page, url: string): Promise<number> {
  const res = await page.goto(url);
  return res?.status() ?? 0;
}

/** คลิกแล้วรอหน้าโหลด (รองรับทั้ง form POST + redirect และ fetch แบบไม่เปลี่ยนหน้า) */
export async function act(page: Page, loc: Locator): Promise<void> {
  await loc.click();
  await page.waitForLoadState('load');
}

/**
 * กรอกเหตุผลแล้วยืนยัน (ตีกลับ/ไม่อนุมัติ/แสดงเลขเต็ม)
 * ถ้าช่องเหตุผลยังไม่แสดง กดปุ่มเปิดก่อน
 */
export async function submitReason(
  page: Page,
  ids: { open: string; input: string; submit: string },
  reason: string,
): Promise<void> {
  const input = tid(page, ids.input);
  if (!(await input.isVisible())) await tid(page, ids.open).click();
  await expect(input).toBeVisible();
  await input.fill(reason);
  await act(page, tid(page, ids.submit));
}

export const RETURN_IDS = { open: 'return-btn', input: 'return-reason', submit: 'return-submit' };
export const REJECT_IDS = { open: 'reject-btn', input: 'reject-reason', submit: 'reject-submit' };
export const UNMASK_IDS = { open: 'show-full-id-btn', input: 'unmask-reason', submit: 'unmask-submit' };

/** เลือกค่าใน select แล้วรอให้หน้าตั้งตัว (หน้าอาจ reload เมื่อ change) */
export async function selectSettle(page: Page, id: string, value: string): Promise<void> {
  const nav = page.waitForEvent('framenavigated', { timeout: 1000 }).catch(() => null);
  await tid(page, id).selectOption(value);
  await nav;
  await page.waitForLoadState('load');
  await expect(tid(page, id)).toHaveValue(value);
}

/** ค่า attribute ของทุกแถว ตามลำดับบนจอ */
export async function attrs(loc: Locator, attr: string): Promise<string[]> {
  return loc.evaluateAll((els, a) => els.map((e) => e.getAttribute(a as string) ?? ''), attr);
}

/** กรอง Audit บนหน้า /audit */
export async function auditFilterUI(
  page: Page,
  f: { actor?: string; event?: string; from?: string; to?: string },
): Promise<void> {
  await tid(page, 'audit-filter-actor').fill(f.actor ?? '');
  await tid(page, 'audit-filter-event').selectOption(f.event ?? '');
  await tid(page, 'audit-filter-from').fill(f.from ?? '');
  await tid(page, 'audit-filter-to').fill(f.to ?? '');
  await act(page, tid(page, 'audit-apply-btn'));
}

/** ชื่อไฟล์จาก Content-Disposition */
export function dispositionName(cd: string | undefined | null): string {
  if (!cd) return '';
  const star = /filename\*\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (star) return decodeURIComponent(star[1]);
  const m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return m ? m[1] : '';
}

export interface Grabbed {
  body: Buffer;
  filename: string;
  contentType: string | null;
}

/**
 * กดปุ่ม/ลิงก์ดาวน์โหลดแล้วได้ไฟล์
 * - ลิงก์ที่มี href → เรียก URL นั้นด้วย cookie ของหน้า (ได้ header ครบ)
 * - ปุ่ม → รอเหตุการณ์ download
 */
export async function grab(page: Page, loc: Locator): Promise<Grabbed> {
  const href = await loc.getAttribute('href');
  if (href && !href.startsWith('javascript') && href !== '#') {
    const res = await page.request.get(new URL(href, page.url()).toString());
    expect(res.status(), `GET ${href}`).toBe(200);
    const h = res.headers();
    return { body: await res.body(), filename: dispositionName(h['content-disposition']), contentType: h['content-type'] ?? null };
  }
  let contentType: string | null = null;
  const onResp = (r: import('@playwright/test').Response) => {
    const h = r.headers();
    if (h['content-disposition']) contentType = h['content-type'] ?? null;
  };
  page.on('response', onResp);
  const [dl] = await Promise.all([page.waitForEvent('download'), loc.click()]);
  const p = await dl.path();
  page.off('response', onResp);
  return { body: fs.readFileSync(p as string), filename: dl.suggestedFilename(), contentType };
}

// ───────────────────────── PDF / XLSX / CSV ─────────────────────────

function readPdfStrings(content: string): string[] {
  const out: string[] = [];
  let arr: string[] | null = null;
  let i = 0;
  const push = (s: string) => (arr ? arr.push(s) : out.push(s));
  while (i < content.length) {
    const c = content[i];
    if (c === '(') {
      let depth = 1;
      let s = '';
      i++;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '\\') {
          const nx = content[i + 1];
          const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (nx in map) {
            s += map[nx];
            i += 2;
          } else if (/[0-7]/.test(nx)) {
            const m = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))![0];
            s += String.fromCharCode(parseInt(m, 8));
            i += 1 + m.length;
          } else {
            i += 2;
          }
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
        s += ch;
        i++;
      }
      push(s);
      i++;
    } else if (c === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) break;
      const hex = content.slice(i + 1, end).replace(/\s+/g, '');
      if (/^[0-9a-fA-F]*$/.test(hex) && hex.length > 0) {
        const b = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
        const utf16 = b[0] === 0xfe && b[1] === 0xff && b.length % 2 === 0;
        push(utf16 ? Buffer.from(b.subarray(2)).swap16().toString('utf16le') : b.toString('latin1'));
      }
      i = end + 1;
    } else if (c === '<' && content[i + 1] === '<') {
      i += 2;
    } else if (c === '[') {
      arr = [];
      i++;
    } else if (c === ']') {
      if (arr) out.push(arr.join(''));
      arr = null;
      i++;
    } else i++;
  }
  return out;
}

/** ข้อความที่ดึงจาก PDF (สตริงใน content stream ทั้งแบบ Flate และไม่บีบอัด · + pdf-parse ถ้าติดตั้งไว้) */
export async function pdfText(buf: Buffer): Promise<string> {
  const parts: string[] = [];
  const raw = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const data = buf.subarray(start, end);
    let content: string;
    try {
      content = zlib.inflateSync(data).toString('latin1');
    } catch {
      content = data.toString('latin1');
    }
    parts.push(...readPdfStrings(content));
    re.lastIndex = end;
  }
  for (const mod of ['pdf-parse/lib/pdf-parse.js', 'pdf-parse']) {
    try {
      const name = mod;
      const lib: any = await import(name);
      const fn = lib?.default ?? lib;
      if (typeof fn === 'function') {
        parts.push((await fn(buf)).text);
        break;
      }
      if (lib?.PDFParse) {
        const p = new lib.PDFParse({ data: buf });
        parts.push((await p.getText()).text);
        break;
      }
    } catch {
      /* ไม่มี pdf-parse → ใช้ตัวดึงสตริงด้านบน */
    }
  }
  return parts.join('\n');
}

/** PDF มีบรรทัด ASCII นี้ (ค้นในข้อความที่ดึงออก หรือไบต์ดิบกรณีไม่บีบอัด) */
export async function pdfHasLine(buf: Buffer, line: string): Promise<boolean> {
  const text = await pdfText(buf);
  return text.includes(line) || buf.toString('latin1').includes(line);
}

/** อ่านชีตแรกของ xlsx เป็นตาราง [แถว][คอลัมน์] ข้อความ (ใช้ exceljs) */
export async function xlsxFirstSheet(buf: Buffer): Promise<string[][]> {
  const ExcelJS: any = await import('exceljs');
  const Workbook = ExcelJS.Workbook ?? ExcelJS.default?.Workbook;
  const wb = new Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row: any, r: number) => {
    const vals: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell: any, c: number) => {
      vals[c - 1] = cellText(cell.value);
    });
    rows[r - 1] = vals;
  });
  return rows.map((r) => r ?? []);
}

function cellText(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t: any) => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text);
  }
  return String(v);
}

/** แยก CSV (รองรับเครื่องหมายคำพูด) */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ───────────────────────── NFR ─────────────────────────

/** ไฟล์ฐานข้อมูลบนเครื่องที่รัน test (docker-compose mount ./data → /data) */
export function dbCandidates(): string[] {
  const list = [
    process.env.HOST_DB_PATH,
    process.env.DB_PATH,
    path.resolve(__dirname, '../../data/egov.db'),
  ].filter((p): p is string => !!p);
  return [...new Set(list)];
}

/** ไฟล์ที่ต้องค้น: ฐานข้อมูล + WAL/journal + ไฟล์/โฟลเดอร์เพิ่มเติมใน PII_SCAN_PATHS (คั่น ,) */
export function scanTargets(dbFile: string): string[] {
  const out = [dbFile, `${dbFile}-wal`, `${dbFile}-journal`, `${dbFile}-shm`].filter((f) => fs.existsSync(f));
  const extra = (process.env.PII_SCAN_PATHS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    else out.push(p);
  };
  extra.forEach(walk);
  return [...new Set(out)];
}

/** นับจำนวนครั้งที่พบสตริง (ไบต์ UTF-8) ในไฟล์ = grep -a -c แบบนับทุกตำแหน่ง */
export function countInFile(file: string, needle: string): number {
  const buf = fs.readFileSync(file);
  const nb = Buffer.from(needle, 'utf8');
  let n = 0;
  let i = buf.indexOf(nb);
  while (i >= 0) {
    n++;
    i = buf.indexOf(nb, i + 1);
  }
  return n;
}
