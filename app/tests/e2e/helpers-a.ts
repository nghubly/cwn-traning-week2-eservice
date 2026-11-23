/**
 * helpers-a.ts · ตัวช่วยของชุด A (AUTH–NOTI) ตาม TEST-PLAN §0
 * แหล่งค่าทุกตัว: TEST-PLAN · CONTRACT · TEST-DATA เท่านั้น (ไม่อ่านโค้ดเว็บ)
 *
 * หลัก: reset ล้าง session ทุกคน (CONTRACT 0.9) → หลัง reset ทุกครั้งสร้าง context ใหม่และล็อกอินใหม่
 * fixture `h` (Harness) สร้าง/ปิด context ทั้งหมดของ test ให้อัตโนมัติ
 */
import {
  test as base,
  expect,
  request as pwRequest,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from '@playwright/test';
import * as zlib from 'zlib';
import { recordVideoOpts } from './video';

// ───────────────────────── ค่าคงที่ ─────────────────────────

export const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
export const OTP_OK = '123456';
export const PASSWORD = 'Test@1234';
export const T0 = '2026-12-01T09:00:00+07:00';

/** ประชาชน (TEST-DATA 1.1) */
export const CIT = {
  somchai: '1101700123456', // สมชาย ใจดี · คำขอ 10 ใบ + ร่าง 2
  somying: '3100600987659', // สมหญิง รักไทย · คำขอ 11 ใบ
  mana: '5500400111221', // มานะ ตั้งใจ · ยังไม่ลงทะเบียน
  piti: '1909900555015', // ปิติ มีสุข · คำขอ 9 ใบ
} as const;

/** ชื่อแสดงเจ้าหน้าที่ (TEST-DATA 1.2 · CONTRACT 3) */
export const STAFF_NAME: Record<string, string> = {
  'off.reg1': 'เจ้าหน้าที่ทะเบียน 1',
  'off.reg2': 'เจ้าหน้าที่ทะเบียน 2',
  'off.works1': 'เจ้าหน้าที่โยธา 1',
  head1: 'หัวหน้าฝ่าย',
  exec1: 'ผู้บริหาร',
  audit1: 'ผู้ตรวจสอบภายใน',
  admin1: 'ผู้ดูแลระบบ',
};

/** เลขคำขอ: cn(25) = EG-2569-000025 · cn(1, 2570) = EG-2570-000001 */
export const cn = (n: number, year = 2569) => `EG-${year}-${String(n).padStart(6, '0')}`;
export const rc = (n: number, year = 2569) => `RC-${year}-${String(n).padStart(6, '0')}`;

export type ServiceId = 'SV-01' | 'SV-02' | 'SV-03';

/** เอกสารบังคับตาม TEST-DATA ข้อ 11 / TEST-PLAN §0 NEW_PAID */
export const REQUIRED_DOCS: Record<ServiceId, Array<[docKey: string, fileName: string]>> = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [
    ['id-card', 'id-card.pdf'],
    ['map', 'map.pdf'],
  ],
  'SV-03': [
    ['id-card', 'id-card.pdf'],
    ['plan', 'plan.pdf'],
    ['deed', 'deed.pdf'],
  ],
};

// ───────────────────────── ไฟล์ทดสอบ (TEST-DATA ข้อ 11 · สร้างในหน่วยความจำ ขนาดตรงไบต์) ─────────────────────────

export type FilePayload = { name: string; mimeType: string; buffer: Buffer };

export function pdfBytes(n: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error('pdf too small');
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
export function pngBytes(n: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  const base = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const pad = n - base.length - 12;
  const text = Buffer.concat([Buffer.from([0x6b, 0x00]), Buffer.alloc(pad - 2, 0x78)]);
  return Buffer.concat([base.subarray(0, base.length - 12), pngChunk('tEXt', text), base.subarray(base.length - 12)]);
}
export function jpgBytes(n: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(pad + 2);
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), len, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
}

const MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', txt: 'text/plain' };
const fileCache = new Map<string, Buffer>();

/** ไฟล์ทดสอบตามชื่อใน TEST-DATA ข้อ 11 · mimeType ตามนามสกุล (เหมือนเบราว์เซอร์) เว้นแต่ระบุ */
export function tf(name: string, mimeType?: string): FilePayload {
  let buf = fileCache.get(name);
  if (!buf) {
    const size = /^size-(\d+)\.pdf$/.exec(name);
    if (size) buf = pdfBytes(Number(size[1]));
    else if (['ok-id.pdf', 'id-card.pdf', 'map.pdf', 'plan.pdf', 'deed.pdf'].includes(name) || /^multi-[1-6]\.pdf$/.test(name))
      buf = pdfBytes(1024);
    else if (name === 'real.jpg' || name === 'plan-as-jpg.jpg') buf = jpgBytes(1024);
    else if (name === 'real.png') buf = pngBytes(1024);
    else if (['fake-text.pdf', 'fake-text.jpg', 'notes.txt'].includes(name)) buf = Buffer.from('hello', 'latin1');
    else if (name === 'exe-as.png') buf = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(1022, 0)]);
    else throw new Error(`unknown test file ${name}`);
    fileCache.set(name, buf);
  }
  const ext = name.split('.').pop() as string;
  return { name, mimeType: mimeType ?? MIME[ext] ?? 'application/octet-stream', buffer: buf };
}

// ───────────────────────── HTTP พื้นฐาน ─────────────────────────

export async function body(r: APIResponse): Promise<any> {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** ตรวจ HTTP + `code` (+ `message` ตรงตัว ถ้าระบุ) ตามรูปแบบ {"code","message"} (CONTRACT 0.6) */
export async function expectErr(r: APIResponse, status: number, code?: string, message?: string): Promise<any> {
  const b = await body(r);
  expect(r.status(), `HTTP ${r.url()} → ${JSON.stringify(b)}`).toBe(status);
  if (code) expect(b?.code, `code of ${r.url()}`).toBe(code);
  if (message) expect(b?.message).toBe(message);
  return b;
}

export async function expectOk(r: APIResponse, status = 200): Promise<any> {
  const b = await body(r);
  expect(r.status(), `HTTP ${r.url()} → ${JSON.stringify(b)}`).toBe(status);
  return b;
}

// ───────────────────────── ยืนยันตัวตน (API) ─────────────────────────

export const thaidStart = (api: APIRequestContext, idNo: string) => api.post('/api/auth/thaid/start', { data: { idNo } });
export const thaidVerify = (api: APIRequestContext, idNo: string, otp: string) =>
  api.post('/api/auth/thaid/verify', { data: { idNo, otp } });

/** LOGIN_C: start + verify OTP 123456 */
export async function loginCitizen(api: APIRequestContext, idNo: string = CIT.somchai): Promise<any> {
  await expectOk(await thaidStart(api, idNo));
  return expectOk(await thaidVerify(api, idNo, OTP_OK));
}

/** LOGIN_S: staff login รหัสผ่าน Test@1234 */
export async function loginStaff(api: APIRequestContext, username: string): Promise<any> {
  return expectOk(await api.post('/api/auth/staff/login', { data: { username, password: PASSWORD } }));
}

// ───────────────────────── ประชาชน: ร่าง ไฟล์ ชำระ ─────────────────────────

export type DraftOpts = { qty?: number; areaSqm?: number };

export function draftBody(serviceId: ServiceId, o: DraftOpts = {}): Record<string, unknown> {
  if (serviceId === 'SV-01') return { serviceId, qty: o.qty ?? 1 };
  if (serviceId === 'SV-03') return { serviceId, areaSqm: o.areaSqm ?? 100 };
  return { serviceId };
}

export async function createDraft(api: APIRequestContext, serviceId: ServiceId, o: DraftOpts = {}) {
  const b = await expectOk(await api.post('/api/drafts', { data: draftBody(serviceId, o) }), 201);
  expect(b.draftId).toMatch(/^DR-\d{4}$/);
  return b as { draftId: string; fee: number };
}

export const uploadFile = (api: APIRequestContext, draftId: string, docKey: string, file: FilePayload) =>
  api.post(`/api/drafts/${draftId}/files`, { multipart: { file, docKey } });

export async function uploadRequired(api: APIRequestContext, draftId: string, serviceId: ServiceId) {
  for (const [docKey, name] of REQUIRED_DOCS[serviceId]) await expectOk(await uploadFile(api, draftId, docKey, tf(name)), 201);
}

export async function createQr(api: APIRequestContext, draftId: string) {
  const b = await expectOk(await api.post(`/api/drafts/${draftId}/payment`), 201);
  expect(b.ref).toMatch(/^PP-\d{4}$/);
  return b as { ref: string; amount: number; qrCreatedAt: string; qrExpiresAt: string };
}

/** POST /api/test/payments/<ref>/pay (test hook) */
export const pay = (api: APIRequestContext, ref: string, amount: number) =>
  api.post(`/api/test/payments/${ref}/pay`, { data: { amount } });

export const getPayment = (api: APIRequestContext, ref: string) => api.get(`/api/payments/${ref}`);

/** ร่าง + ไฟล์บังคับ + QR (ยังไม่ชำระ) */
export async function newPending(api: APIRequestContext, serviceId: ServiceId, o: DraftOpts = {}) {
  const d = await createDraft(api, serviceId, o);
  await uploadRequired(api, d.draftId, serviceId);
  const q = await createQr(api, d.draftId);
  return { draftId: d.draftId, fee: d.fee, ref: q.ref, amount: q.amount };
}

/** ส่วนท้ายของ NEW_PAID: ร่าง → ไฟล์ → QR → pay ครบ → GET payment ได้ caseNo */
export async function payNew(api: APIRequestContext, serviceId: ServiceId, o: DraftOpts = {}) {
  const p = await newPending(api, serviceId, o);
  const paid = await expectOk(await pay(api, p.ref, p.fee));
  expect(paid.status).toBe('PAID');
  const g = await expectOk(await getPayment(api, p.ref));
  expect(g.caseNo).toBe(paid.caseNo);
  return { ...p, caseNo: paid.caseNo as string, receiptNo: paid.receiptNo as string };
}

export async function myCases(api: APIRequestContext): Promise<any[]> {
  return (await expectOk(await api.get('/api/cases'))).items;
}

export async function getCase(api: APIRequestContext, caseNo: string): Promise<any> {
  return expectOk(await api.get(`/api/cases/${caseNo}`));
}

// ───────────────────────── เจ้าหน้าที่ ─────────────────────────

export const claim = (api: APIRequestContext, caseNo: string) => api.post(`/api/officer/cases/${caseNo}/claim`);
export const returnCase = (api: APIRequestContext, caseNo: string, reason = 'xxxxxxxxxx') =>
  api.post(`/api/officer/cases/${caseNo}/return`, { data: { reason } });
export const resubmit = (api: APIRequestContext, caseNo: string) => api.post(`/api/cases/${caseNo}/resubmit`);

/** รายการแจ้งเตือนของผู้ใช้เป็นคู่ "caseNo|level" เรียงแล้ว */
export async function notiPairs(api: APIRequestContext): Promise<string[]> {
  const b = await expectOk(await api.get('/api/notifications'));
  return (b.items as any[]).map((i) => `${i.caseNo}|${i.level}`).sort();
}

export const pairs = (list: Array<[number, 'near' | 'overdue']>) => list.map(([n, l]) => `${cn(n)}|${l}`).sort();

// ───────────────────────── UI ─────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** URL ปัจจุบันมี pathname ตรง path (ยอม query/hash) */
export async function expectPath(page: Page, path: string) {
  await expect(page).toHaveURL(new RegExp(`^https?://[^/]+${esc(path)}(?:[?#].*)?$`));
}

/** องค์ประกอบ testid ที่มีแอตทริบิวต์ตรงค่า เช่น byAttr(page,'queue-row','data-case-no',cn(28)) */
export const byAttr = (scope: Page | Locator, testid: string, attr: string, value: string) =>
  scope.locator(`[data-testid="${testid}"][${attr}="${value}"]`);

export async function attrs(loc: Locator, attr: string): Promise<string[]> {
  return loc.evaluateAll((els, a) => els.map((e) => e.getAttribute(a as string) ?? ''), attr);
}

/** ล็อกอินประชาชนผ่านหน้า /login (ThaiD จำลอง) */
export async function uiLoginCitizen(page: Page, idNo: string) {
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await page.getByTestId('thaid-id-input').fill(idNo);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();
  await page.getByTestId('otp-input').fill(OTP_OK);
  await page.getByTestId('otp-submit').click();
}

/** ล็อกอินเจ้าหน้าที่ผ่านแท็บเจ้าหน้าที่ */
export async function uiLoginStaff(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await page.getByTestId('staff-username').fill(username);
  await page.getByTestId('staff-password').fill(password);
  await page.getByTestId('staff-submit').click();
}

export async function queueCaseNos(page: Page): Promise<string[]> {
  return attrs(page.getByTestId('queue-row'), 'data-case-no');
}

/** เปิด /officer/queue แล้วตั้ง filter (รอให้หน้าตอบสนอง) */
export async function openQueue(page: Page, filter?: 'all' | 'unclaimed' | 'mine') {
  await page.goto('/officer/queue');
  if (filter && filter !== 'all') {
    await page.getByTestId('queue-filter').selectOption(filter);
    await expect(page.getByTestId('queue-filter')).toHaveValue(filter);
  }
}

/** ลำดับเลขคำขอในคิวตรงตามที่คาด (รอจน DOM คงที่) */
export async function expectQueue(page: Page, expected: string[]) {
  await expect.poll(() => queueCaseNos(page)).toEqual(expected);
}

export async function expectWorkload(page: Page, n: number) {
  await page.goto('/officer/queue');
  await expect(page.getByTestId('workload-count')).toHaveText(String(n));
}

/** แจ้งเตือนบนหน้า /notifications เป็นคู่ "caseNo|level" */
export async function uiNotiPairs(page: Page): Promise<string[]> {
  await page.goto('/notifications');
  const items = page.getByTestId('noti-item');
  const c = await attrs(items, 'data-case-no');
  const l = await attrs(items, 'data-level');
  return c.map((x, i) => `${x}|${l[i]}`).sort();
}

/** ขั้น 1 ของ wizard: กรอกค่า (ถ้ามี) แล้วไปขั้นแนบเอกสาร */
export async function wizardToUpload(page: Page, serviceId: ServiceId, o: DraftOpts = {}) {
  await page.goto(`/citizen/new/${serviceId}`);
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  if (serviceId === 'SV-01') await page.getByTestId('qty-input').fill(String(o.qty ?? 1));
  if (serviceId === 'SV-03') await page.getByTestId('area-input').fill(String(o.areaSqm ?? 100));
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
}

export async function uiUpload(page: Page, docKey: string, files: FilePayload | FilePayload[]) {
  await page.getByTestId(`upload-input-${docKey}`).setInputFiles(files);
}

export async function uiRemoveFile(page: Page, name: string) {
  await byAttr(page, 'file-item', 'data-name', name).getByTestId('file-remove-btn').click();
  await expect(byAttr(page, 'file-item', 'data-name', name)).toHaveCount(0);
}

// ───────────────────────── Harness (fixture) ─────────────────────────

export type Actor = { api: APIRequestContext };
export type PageActor = { context: BrowserContext; page: Page; api: APIRequestContext };

export class Harness {
  private apis: APIRequestContext[] = [];
  private contexts: BrowserContext[] = [];
  constructor(private browser: Browser) {}

  /** request context ใหม่ที่ไม่มี cookie */
  async anonApi(): Promise<APIRequestContext> {
    const a = await pwRequest.newContext({ baseURL: BASE_URL });
    this.apis.push(a);
    return a;
  }

  /** RESET: POST /api/test/reset → 200 now = 2026-12-01T09:00:00+07:00 */
  async reset() {
    const a = await this.anonApi();
    const b = await expectOk(await a.post('/api/test/reset'));
    expect(b).toMatchObject({ ok: true, now: T0 });
  }

  /** CLOCK(t): PUT /api/test/clock (นาฬิกาแช่แข็ง) */
  async clock(now: string) {
    const a = await this.anonApi();
    const b = await expectOk(await a.put('/api/test/clock', { data: { now } }));
    expect(b.now).toBe(now);
  }

  /** pay ผ่าน test hook (ไม่ต้องใช้ cookie) */
  async pay(ref: string, amount: number) {
    return pay(await this.anonApi(), ref, amount);
  }

  async citizen(idNo: string = CIT.somchai): Promise<Actor> {
    const api = await this.anonApi();
    await loginCitizen(api, idNo);
    return { api };
  }

  async staff(username: string): Promise<Actor> {
    const api = await this.anonApi();
    await loginStaff(api, username);
    return { api };
  }

  async anonPage(): Promise<PageActor> {
    const context = await this.browser.newContext({ baseURL: BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok', ...recordVideoOpts() });
    this.contexts.push(context);
    const page = await context.newPage();
    return { context, page, api: context.request };
  }

  /** browser context ใหม่ ล็อกอินประชาชนผ่าน API (cookie ใช้ร่วมกับหน้า) */
  async citizenPage(idNo: string = CIT.somchai): Promise<PageActor> {
    const a = await this.anonPage();
    await loginCitizen(a.api, idNo);
    return a;
  }

  async staffPage(username: string): Promise<PageActor> {
    const a = await this.anonPage();
    await loginStaff(a.api, username);
    return a;
  }

  /** NEW_PAID(ผู้ยื่น, บริการ, เวลา, ตัวเลือก): CLOCK → LOGIN_C → ร่าง → ไฟล์ → QR → pay → caseNo */
  async newPaid(serviceId: ServiceId, o: DraftOpts & { at?: string; who?: string } = {}) {
    if (o.at) await this.clock(o.at);
    const c = await this.citizen(o.who ?? CIT.somchai);
    const r = await payNew(c.api, serviceId, o);
    return { ...r, api: c.api };
  }

  /** จำนวนแถว Audit ของเหตุการณ์ + คำขอ (ตรวจผ่าน audit1) */
  async auditCount(event: string, caseNo: string): Promise<number> {
    const a = await this.staff('audit1');
    const b = await expectOk(await a.api.get(`/api/audit?event=${event}`));
    return (b.items as any[]).filter((i) => i.event === event && i.caseNo === caseNo).length;
  }

  async dispose() {
    for (const c of this.contexts) await c.close().catch(() => {});
    for (const a of this.apis) await a.dispose().catch(() => {});
  }
}

export const test = base.extend<{ h: Harness }>({
  h: async ({ browser }, use) => {
    const h = new Harness(browser);
    await use(h);
    await h.dispose();
  },
});

export { expect };
