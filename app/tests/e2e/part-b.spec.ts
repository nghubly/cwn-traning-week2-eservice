/**
 * part-b.spec.ts · Playwright ชุด B: WORKFLOW – NFR (29 TC)
 * WORKFLOW 6 · DOC 3 · PDPA 3 · DASH 4 · AUDIT 3 · RBAC 6 · NFR 4
 *
 * ค่าคาดหวังทุกตัวคัดจากการ์ด TC ใน TEST-PLAN §10–§16 (คิดจากกฎ/seed ไม่ได้อ่านจากหน้าจอเว็บ)
 * ทุก TC เริ่มด้วย RESET และล็อกอินใหม่หลัง RESET ทุกครั้ง (CONTRACT 0.9)
 * TC ที่จับบั๊กสิทธิ์ (B06 B07 B09 B11 …) ยิง API ตรง ไม่เชื่อแค่ปุ่มที่ซ่อน
 * ต้องรันแบบ workers: 1 (สถานะเซิร์ฟเวอร์ใช้ร่วมกัน) — ตั้งไว้ใน playwright.config.ts แล้ว
 */
import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as fs from 'node:fs';
import {
  BASE_URL,
  T0,
  ID,
  PII_IDS,
  PII_IDS_DASHED,
  PII_MOBILES,
  MASKED_RE,
  VERIFY_CODE_RE,
  STATUS_TH,
  LEVEL_TH,
  MSG,
  cn,
  pdfFile,
  closeAll,
  rawApi,
  asAnon,
  asStaff,
  asCitizen,
  reset,
  setClock,
  newPaid,
  json,
  expectApi,
  getCase,
  dashApi,
  auditApi,
  findKeysDeep,
  expectNoPII,
  tid,
  expectStatus,
  expectCount,
  open,
  act,
  submitReason,
  RETURN_IDS,
  REJECT_IDS,
  UNMASK_IDS,
  selectSettle,
  attrs,
  auditFilterUI,
  dispositionName,
  grab,
  pdfText,
  pdfHasLine,
  xlsxFirstSheet,
  parseCsv,
  dbCandidates,
  scanTargets,
  countInFile,
  type Actor,
} from './helpers-b';

const X10 = 'xxxxxxxxxx'; // เหตุผล 10 ตัว (A-44)
const X9 = 'xxxxxxxxx'; // 9 ตัว
const SP10 = '          '; // เว้นวรรคล้วน 10 ตัว

test.afterEach(async () => {
  await closeAll();
});

/** ตรวจหน้า /verify/<code> (UI) + GET /api/verify/<code> */
async function expectVerify(
  page: Page,
  code: string,
  result: 'VALID' | 'EXPIRED' | 'TAMPERED' | 'NOT_FOUND',
  expiresIso?: string,
): Promise<void> {
  const TH = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง', NOT_FOUND: 'ไม่พบเอกสาร' };
  const status = await open(page, `/verify/${code}`);
  expect(status, `/verify/${code} HTTP`).toBe(result === 'NOT_FOUND' ? 404 : 200);
  expect(new URL(page.url()).pathname).toBe(`/verify/${code}`);
  await expect(tid(page, 'verify-result')).toHaveText(TH[result]);
  await expect(tid(page, 'verify-result')).toHaveAttribute('data-result', result);
  if (result === 'TAMPERED' || result === 'NOT_FOUND') {
    await expectCount(page, 'verify-doc-no', 0);
    await expectCount(page, 'verify-applicant', 0);
  }
  if (expiresIso) await expect(tid(page, 'verify-expires')).toHaveAttribute('data-iso', expiresIso);
  const r = await page.request.get(`/api/verify/${code}`);
  expect(r.status()).toBe(result === 'NOT_FOUND' ? 404 : 200);
  const j = await r.json();
  expect(j.result).toBe(result);
  if (expiresIso && (result === 'VALID' || result === 'EXPIRED')) expect(j.validUntil).toBe(expiresIso);
}

// ═════════════════════════════════ §10 WORKFLOW ═════════════════════════════════

test.describe('§10 WORKFLOW', () => {
  test('TC-WORKFLOW-01 · SV-01 อนุมัติ + ออกเอกสาร', async ({ browser }) => {
    await reset();
    const reg2 = await asStaff(browser, 'off.reg2');
    const p = reg2.page;
    const C25 = cn(25);

    await test.step('1 ตรวจปุ่ม', async () => {
      await open(p, `/officer/cases/${C25}`);
      await expectStatus(p, 'IN_REVIEW');
      await expectCount(p, 'approve-btn', 1);
      await expectCount(p, 'return-btn', 1);
      await expectCount(p, 'reject-btn', 1);
      await expectCount(p, 'forward-btn', 0);
      await expectCount(p, 'issue-btn', 0);
      await expect(tid(p, 'case-fee')).toHaveText('฿60');
    });

    await test.step('2 off.reg1 อนุมัติ …000026 ที่ off.reg2 ถือ → 403', async () => {
      const reg1 = await asStaff(browser, 'off.reg1');
      await expectApi(await reg1.api.post(`/api/cases/${cn(26)}/approve`), 403, 'FORBIDDEN');
      expect((await getCase(reg1.api, cn(26))).status).toBe('IN_REVIEW');
    });

    await test.step('3 off.reg2 กด approve-btn', async () => {
      await act(p, tid(p, 'approve-btn'));
      await expectStatus(p, 'APPROVED');
      await expectCount(p, 'issue-btn', 1);
      await expectCount(p, 'approve-btn', 0);
    });

    await test.step('4 กด issue-btn', async () => {
      await act(p, tid(p, 'issue-btn'));
      await expectStatus(p, 'COMPLETED');
      await expect(tid(p, 'doc-no')).toHaveText('DOC-2569-000002');
      await expect(tid(p, 'verify-code')).toHaveText(VERIFY_CODE_RE);
      await expect(tid(p, 'closed-at')).toHaveAttribute('data-iso', T0);
      await expect(tid(p, 'sla-level')).toHaveText('ปิดแล้ว');
      await expect(tid(p, 'sla-level')).toHaveAttribute('data-level', 'closed');
    });

    await test.step('5 สมหญิงเห็นเสร็จสิ้นและดาวน์โหลด PDF', async () => {
      const sy = await asCitizen(browser, ID.somying);
      await open(sy.page, `/citizen/cases/${C25}`);
      await expectStatus(sy.page, 'COMPLETED');
      await expectCount(sy.page, 'download-doc-btn', 1);
      const f = await grab(sy.page, tid(sy.page, 'download-doc-btn'));
      expect(f.filename).toBe('DOC-2569-000002.pdf');
      if (f.contentType) expect(f.contentType).toContain('application/pdf');
      expect(f.body.subarray(0, 4).toString('latin1')).toBe('%PDF');
      expect(await pdfHasLine(f.body, 'docNo=DOC-2569-000002 caseNo=EG-2569-000025')).toBe(true);
      // header ตรง API ด้วย
      const r = await sy.api.get('/api/documents/DOC-2569-000002/pdf');
      expect(r.status()).toBe(200);
      expect(r.headers()['content-type']).toContain('application/pdf');
      expect(dispositionName(r.headers()['content-disposition'])).toBe('DOC-2569-000002.pdf');
    });

    await test.step('6 exec1 Dashboard ธ.ค.', async () => {
      const ex = await asStaff(browser, 'exec1');
      const d = await dashApi(ex.api, '2026-12');
      expect(d.closed).toBe(1);
      expect(d.onTime).toBe(1);
      expect(d.received).toBe(3);
      expect(d.backlog).toBe(20);
    });
  });

  test('TC-WORKFLOW-02 · SV-02 ผ่านหัวหน้า', async ({ browser }) => {
    const C13 = cn(13);
    await reset();
    const reg2 = await asStaff(browser, 'off.reg2');
    const p = reg2.page;

    await test.step('1 ตรวจปุ่ม', async () => {
      await open(p, `/officer/cases/${C13}`);
      await expectCount(p, 'approve-btn', 0);
      await expectCount(p, 'forward-btn', 1);
      await expectCount(p, 'forward-target', 0);
    });

    await test.step('2 กด forward-btn', async () => {
      await act(p, tid(p, 'forward-btn'));
      await expectStatus(p, 'PENDING_APPROVAL');
      await open(p, '/officer/queue');
      await expect(tid(p, 'workload-count')).toHaveText('8');
      await expect(p.locator(`[data-testid="queue-row"][data-case-no="${C13}"]`)).toHaveCount(0);
    });

    const head = await asStaff(browser, 'head1');
    await test.step('3 head1 /head/approvals 3 แถวตามลำดับ', async () => {
      await open(head.page, '/head/approvals');
      await expectCount(head.page, 'approval-row', 3);
      expect(await attrs(tid(head.page, 'approval-row'), 'data-case-no')).toEqual([cn(13), cn(14), cn(11)]);
    });

    await test.step('4 เปิด …000013', async () => {
      const row = head.page.locator(`[data-testid="approval-row"][data-case-no="${C13}"]`);
      await act(head.page, tid(row, 'approval-open'));
      await expect(head.page).toHaveURL(new RegExp(`/officer/cases/${C13}$`));
      await expectCount(head.page, 'approve-btn', 1);
      await expectCount(head.page, 'reject-btn', 1);
      await expectCount(head.page, 'issue-btn', 0);
    });

    await test.step('5 head1 approve', async () => {
      await act(head.page, tid(head.page, 'approve-btn'));
      await expectStatus(head.page, 'APPROVED');
      await expectCount(head.page, 'issue-btn', 0);
    });

    await test.step('6 off.reg1 ไม่ใช่ผู้รับเรื่อง ออกเอกสารไม่ได้', async () => {
      const reg1 = await asStaff(browser, 'off.reg1');
      await open(reg1.page, `/officer/cases/${C13}`);
      await expectCount(reg1.page, 'issue-btn', 0);
      await expectApi(await reg1.api.post(`/api/officer/cases/${C13}/issue`), 403, 'FORBIDDEN');
    });

    await test.step('7 off.reg2 ออกเอกสาร · verify-signer หัวหน้าฝ่าย', async () => {
      await open(p, `/officer/cases/${C13}`);
      await act(p, tid(p, 'issue-btn'));
      await expectStatus(p, 'COMPLETED');
      await expect(tid(p, 'doc-no')).toHaveText('DOC-2569-000002');
      const code = (await tid(p, 'verify-code').textContent())!.trim();
      expect(code).toMatch(VERIFY_CODE_RE);
      const anon = await asAnon(browser);
      await expectVerify(anon.page, code, 'VALID');
      await expect(tid(anon.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
    });

    await test.step('8 RESET · off.reg1 ออกเอกสาร seed …000019', async () => {
      await reset();
      const reg1 = await asStaff(browser, 'off.reg1');
      await open(reg1.page, `/officer/cases/${cn(19)}`);
      await act(reg1.page, tid(reg1.page, 'issue-btn'));
      await expectStatus(reg1.page, 'COMPLETED');
      await expect(tid(reg1.page, 'doc-no')).toHaveText('DOC-2569-000002');
      const code = (await tid(reg1.page, 'verify-code').textContent())!.trim();
      const anon = await asAnon(browser);
      await expectVerify(anon.page, code, 'VALID');
      await expect(tid(anon.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
    });
  });

  test('TC-WORKFLOW-03 · SV-03 สามขั้นตอน', async ({ browser }) => {
    const C12 = cn(12);
    await reset();
    const reg2 = await asStaff(browser, 'off.reg2');
    const p = reg2.page;

    await test.step('1 ตรวจหน้า', async () => {
      await open(p, `/officer/cases/${C12}`);
      await expect(tid(p, 'case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
      await expect(tid(p, 'case-fee')).toHaveText('฿1,010');
      await expectCount(p, 'forward-btn', 1);
    });

    await test.step('2 ส่งต่อไปโยธา', async () => {
      await act(p, tid(p, 'forward-btn'));
      await expectStatus(p, 'IN_REVIEW');
      await expect(tid(p, 'case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
      await expect(tid(p, 'case-owner')).toHaveText('ยังไม่มีผู้รับ');
      await open(p, '/officer/queue');
      await expect(tid(p, 'workload-count')).toHaveText('8');
    });

    await test.step('3 คิว off.reg2 ไม่มี …000012 (16 แถว)', async () => {
      await expect(p.locator(`[data-testid="queue-row"][data-case-no="${C12}"]`)).toHaveCount(0);
      await expectCount(p, 'queue-row', 16);
    });

    const works = await asStaff(browser, 'off.works1');
    await test.step('4 คิว off.works1', async () => {
      await open(works.page, '/officer/queue');
      await expectCount(works.page, 'queue-row', 2);
      expect(await attrs(tid(works.page, 'queue-row'), 'data-case-no')).toEqual([cn(10), C12]);
      await expectCount(works.page, 'claim-btn', 2);
    });

    await test.step('5 off.reg1 claim ข้ามแผนก → 403', async () => {
      const reg1 = await asStaff(browser, 'off.reg1');
      await expectApi(await reg1.api.post(`/api/officer/cases/${C12}/claim`), 403, 'FORBIDDEN');
    });

    await test.step('6 off.works1 claim แล้วส่งต่อ', async () => {
      const row = works.page.locator(`[data-testid="queue-row"][data-case-no="${C12}"]`);
      await act(works.page, tid(row, 'claim-btn'));
      await open(works.page, `/officer/cases/${C12}`);
      await expect(tid(works.page, 'case-owner')).toHaveText('off.works1');
      await act(works.page, tid(works.page, 'forward-btn'));
      await expectStatus(works.page, 'PENDING_APPROVAL');
      await expect(tid(works.page, 'case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');
    });

    await test.step('7 head1 อนุมัติ', async () => {
      const head = await asStaff(browser, 'head1');
      await open(head.page, '/head/approvals');
      await expectCount(head.page, 'approval-row', 3);
      const row = head.page.locator(`[data-testid="approval-row"][data-case-no="${C12}"]`);
      await expect(row).toHaveCount(1);
      await act(head.page, tid(row, 'approval-open'));
      await act(head.page, tid(head.page, 'approve-btn'));
      await expectStatus(head.page, 'APPROVED');
    });

    await test.step('8 ผู้ออกเอกสาร = ทะเบียนขั้นแรก (off.reg2)', async () => {
      await open(works.page, `/officer/cases/${C12}`);
      await expectCount(works.page, 'issue-btn', 0);
      await open(p, `/officer/cases/${C12}`);
      await expectCount(p, 'issue-btn', 1);
      await act(p, tid(p, 'issue-btn'));
      await expectStatus(p, 'COMPLETED');
      const code = (await tid(p, 'verify-code').textContent())!.trim();
      const anon = await asAnon(browser);
      await expectVerify(anon.page, code, 'VALID');
      await expect(tid(anon.page, 'verify-signer')).toHaveText('หัวหน้าฝ่าย');
    });
  });

  test('TC-WORKFLOW-04 · ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ (B12)', async ({ browser }) => {
    /** ประชาชนกดส่งแก้ไขบนหน้าคำขอ */
    async function citizenFix(c: Actor, caseNo: string) {
      await open(c.page, `/citizen/cases/${caseNo}`);
      await act(c.page, tid(c.page, 'submit-fix-btn'));
      await expectStatus(c.page, 'IN_REVIEW');
    }

    await test.step('ส่วน A · SV-01 …000020 ครั้งที่ 1, 2 ✓ · ครั้งที่ 3 ✗', async () => {
      const C20 = cn(20);
      await reset();
      const reg1 = await asStaff(browser, 'off.reg1');
      const sc = await asCitizen(browser, ID.somchai);
      const p = reg1.page;
      await open(p, `/officer/cases/${C20}`);
      await expect(tid(p, 'return-count')).toHaveText('0');
      // 1
      await submitReason(p, RETURN_IDS, X10);
      await expectStatus(p, 'NEED_FIX');
      await expect(tid(p, 'return-count')).toHaveText('1');
      // 2
      await citizenFix(sc, C20);
      await open(p, `/officer/cases/${C20}`);
      await expectStatus(p, 'IN_REVIEW');
      await expect(tid(p, 'case-owner')).toHaveText('off.reg1');
      // 3
      await submitReason(p, RETURN_IDS, X10);
      await expectStatus(p, 'NEED_FIX');
      await expect(tid(p, 'return-count')).toHaveText('2');
      // 4
      await citizenFix(sc, C20);
      // 5
      await open(p, `/officer/cases/${C20}`);
      await expectStatus(p, 'IN_REVIEW');
      await expectCount(p, 'return-btn', 0);
      await expectApi(
        await reg1.api.post(`/api/officer/cases/${C20}/return`, { data: { reason: X10 } }),
        409,
        'RETURN_LIMIT',
        MSG.RETURN_LIMIT,
      );
      const c = await getCase(reg1.api, C20);
      expect(c.status).toBe('IN_REVIEW');
      expect(c.returnCount).toBe(2);
      await open(p, `/officer/cases/${C20}`);
      await expect(tid(p, 'return-count')).toHaveText('2');
      await expectCount(p, 'approve-btn', 1);
      await expectCount(p, 'reject-btn', 1);
    });

    await test.step('ส่วน B · seed …000023 ตีกลับแล้ว 2 ครั้ง', async () => {
      const C23 = cn(23);
      await reset();
      const reg1 = await asStaff(browser, 'off.reg1');
      const p = reg1.page;
      await open(p, `/officer/cases/${C23}`);
      await expect(tid(p, 'return-count')).toHaveText('2');
      await expectCount(p, 'return-btn', 0);
      await expectApi(
        await reg1.api.post(`/api/officer/cases/${C23}/return`, { data: { reason: X10 } }),
        409,
        'RETURN_LIMIT',
        MSG.RETURN_LIMIT,
      );
      expect((await getCase(reg1.api, C23)).status).toBe('IN_REVIEW');
      await open(p, `/officer/cases/${C23}`);
      await expectStatus(p, 'IN_REVIEW');
      await expectCount(p, 'approve-btn', 1);
      await expectCount(p, 'reject-btn', 1);
    });

    await test.step('ส่วน C · SV-02 …000013 หลังตีกลับครบ 2 ครั้ง', async () => {
      const C13 = cn(13);
      await reset();
      const reg2 = await asStaff(browser, 'off.reg2');
      const sc = await asCitizen(browser, ID.somchai);
      const p = reg2.page;
      await open(p, `/officer/cases/${C13}`);
      await submitReason(p, RETURN_IDS, X10);
      await expectStatus(p, 'NEED_FIX');
      await citizenFix(sc, C13);
      await open(p, `/officer/cases/${C13}`);
      await submitReason(p, RETURN_IDS, X10);
      await expectStatus(p, 'NEED_FIX');
      await expect(tid(p, 'return-count')).toHaveText('2');
      await citizenFix(sc, C13);

      await open(p, `/officer/cases/${C13}`);
      await expectStatus(p, 'IN_REVIEW');
      await expectCount(p, 'return-btn', 0);
      await expectCount(p, 'approve-btn', 0);
      await expectCount(p, 'reject-btn', 0);
      await expectCount(p, 'forward-btn', 1);
      await expectApi(await reg2.api.post(`/api/cases/${C13}/reject`, { data: { reason: X10 } }), 403);
      expect((await getCase(reg2.api, C13)).status).toBe('IN_REVIEW');

      await tid(p, 'forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา');
      await act(p, tid(p, 'forward-btn'));
      await expectStatus(p, 'PENDING_APPROVAL');

      const au = await asStaff(browser, 'audit1');
      const a = await auditApi(au.api, { event: 'FORWARD' });
      const fw = a.items.filter((i: any) => i.caseNo === C13);
      expect(fw.length).toBe(1);
      expect(fw[0].detail).toContain('ส่งต่อให้หัวหน้าพิจารณา');
      await open(au.page, '/audit');
      await auditFilterUI(au.page, { event: 'FORWARD' });
      const row = au.page.locator(`[data-testid="audit-row"][data-case-no="${C13}"]`);
      await expect(row).toHaveCount(1);
      await expect(tid(row, 'audit-detail')).toContainText('ส่งต่อให้หัวหน้าพิจารณา');

      const head = await asStaff(browser, 'head1');
      await open(head.page, `/officer/cases/${C13}`);
      await expectCount(head.page, 'reject-btn', 1);
      await expectCount(head.page, 'approve-btn', 1);
    });
  });

  test('TC-WORKFLOW-05 · เหตุผล ≥ 10 ตัวอักษร (ตีกลับ / ไม่อนุมัติ)', async ({ browser }) => {
    await test.step('ส่วน A · ตีกลับ …000020 (off.reg1)', async () => {
      const C20 = cn(20);
      await reset();
      const reg1 = await asStaff(browser, 'off.reg1');
      const p = reg1.page;
      await open(p, `/officer/cases/${C20}`);
      for (const bad of [X9, SP10]) {
        await submitReason(p, RETURN_IDS, bad);
        await expect(tid(p, 'return-reason-error')).toHaveText(MSG.REASON_TOO_SHORT);
        await expectApi(
          await reg1.api.post(`/api/officer/cases/${C20}/return`, { data: { reason: bad } }),
          400,
          'REASON_TOO_SHORT',
          MSG.REASON_TOO_SHORT,
        );
        await open(p, `/officer/cases/${C20}`);
        await expectStatus(p, 'IN_REVIEW');
      }
      await submitReason(p, RETURN_IDS, X10);
      await expectStatus(p, 'NEED_FIX');
      const sc = await asCitizen(browser, ID.somchai);
      await open(sc.page, `/citizen/cases/${C20}`);
      await expect(tid(sc.page, 'return-reason-display')).toHaveText(X10);
    });

    await test.step('ส่วน B · ไม่อนุมัติ SV-01 …000026 (off.reg2)', async () => {
      const C26 = cn(26);
      await reset();
      const reg2 = await asStaff(browser, 'off.reg2');
      const p = reg2.page;
      await open(p, `/officer/cases/${C26}`);
      await submitReason(p, REJECT_IDS, X9);
      await expect(tid(p, 'reject-reason-error')).toHaveText(MSG.REASON_TOO_SHORT);
      await expectApi(
        await reg2.api.post(`/api/cases/${C26}/reject`, { data: { reason: X9 } }),
        400,
        'REASON_TOO_SHORT',
      );
      await open(p, `/officer/cases/${C26}`);
      await expectStatus(p, 'IN_REVIEW');
      await submitReason(p, REJECT_IDS, X10);
      await expectStatus(p, 'REJECTED');
      await expect(tid(p, 'closed-at')).toHaveAttribute('data-iso', T0);
      await expect(tid(p, 'sla-level')).toHaveText('ปิดแล้ว');
      const sc = await asCitizen(browser, ID.somchai);
      await open(sc.page, `/citizen/cases/${C26}`);
      await expect(tid(sc.page, 'no-refund-note')).toHaveText(MSG.NO_REFUND);
      const ex = await asStaff(browser, 'exec1');
      const d = await dashApi(ex.api, '2026-12');
      expect(d.closed).toBe(1);
      expect(d.onTime).toBe(1);
    });

    await test.step('ส่วน C · หัวหน้าไม่อนุมัติ …000011 (head1)', async () => {
      const C11 = cn(11);
      await reset();
      const head = await asStaff(browser, 'head1');
      await expectApi(await head.api.post(`/api/cases/${C11}/reject`, { data: { reason: X9 } }), 400, 'REASON_TOO_SHORT');
      expect((await getCase(head.api, C11)).status).toBe('PENDING_APPROVAL');
      const ok = await expectApi(await head.api.post(`/api/cases/${C11}/reject`, { data: { reason: X10 } }), 200);
      expect(ok.status).toBe('REJECTED');
      expect((await getCase(head.api, C11)).status).toBe('REJECTED');
    });
  });

  test('TC-WORKFLOW-06 · เวลาแก้ไข 168 ชั่วโมง', async ({ browser }) => {
    const C17 = cn(17);
    await test.step('หน้าตั้งต้น', async () => {
      await reset();
      const sc = await asCitizen(browser, ID.somchai);
      const p = sc.page;
      await open(p, `/citizen/cases/${C17}`);
      await expectStatus(p, 'NEED_FIX');
      await expect(tid(p, 'return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
      await expect(tid(p, 'fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
      await expect(tid(p, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-04T14:00:00+07:00');
      await expectCount(p, 'submit-fix-btn', 1);
    });

    await test.step('รอบ A · 13:59 (167:59) ส่งแก้ได้', async () => {
      await reset();
      await setClock('2026-12-04T13:59:00+07:00');
      const sc = await asCitizen(browser, ID.somchai);
      const p = sc.page;
      await open(p, `/citizen/cases/${C17}`);
      await expect(tid(p, 'submit-fix-btn')).toBeEnabled();
      await act(p, tid(p, 'submit-fix-btn'));
      await expectStatus(p, 'IN_REVIEW');
      expect((await getCase(sc.api, C17)).status).toBe('IN_REVIEW');
    });

    await test.step('รอบ B · 14:00 (168:00) ยกเลิกอัตโนมัติ', async () => {
      await reset();
      await setClock('2026-12-04T14:00:00+07:00');
      const sc = await asCitizen(browser, ID.somchai);
      const p = sc.page;
      await open(p, `/citizen/cases/${C17}`);
      await expectStatus(p, 'CANCELLED');
      await expectCount(p, 'submit-fix-btn', 0);
      await expect(tid(p, 'no-refund-note')).toHaveText(MSG.NO_REFUND);
      await expectApi(await sc.api.post(`/api/cases/${C17}/resubmit`), 409);
      await expect(
        p.locator('[data-testid="case-timeline"] [data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]'),
      ).not.toHaveCount(0);
      const ex = await asStaff(browser, 'exec1');
      expect((await dashApi(ex.api, '2026-12')).backlog).toBe(20);
    });
  });
});

// ═════════════════════════════════ §11 DOC ═════════════════════════════════

test.describe('§11 DOC', () => {
  /** off.reg2 approve + issue …000025 ผ่าน API → verifyCode */
  async function approveIssue25(reg2: Actor, expectDocNo: string): Promise<string> {
    const C25 = cn(25);
    const a = await expectApi(await reg2.api.post(`/api/cases/${C25}/approve`), 200);
    expect(a.status).toBe('APPROVED');
    const i = await expectApi(await reg2.api.post(`/api/officer/cases/${C25}/issue`), 200);
    expect(i.docNo).toBe(expectDocNo);
    expect(i.status).toBe('COMPLETED');
    expect(i.verifyCode).toMatch(VERIFY_CODE_RE);
    return i.verifyCode;
  }
  async function issue19(reg1: Actor, expectDocNo: string): Promise<string> {
    const i = await expectApi(await reg1.api.post(`/api/officer/cases/${cn(19)}/issue`), 200);
    expect(i.docNo).toBe(expectDocNo);
    expect(i.status).toBe('COMPLETED');
    expect(i.verifyCode).toMatch(VERIFY_CODE_RE);
    return i.verifyCode;
  }

  test('TC-DOC-01 · ออกเอกสารและข้อมูลในเอกสาร', async ({ browser }) => {
    await reset();
    const reg2 = await asStaff(browser, 'off.reg2');
    const code = await approveIssue25(reg2, 'DOC-2569-000002');

    await test.step('สมหญิงดาวน์โหลด PDF', async () => {
      const sy = await asCitizen(browser, ID.somying);
      const r = await sy.api.get('/api/documents/DOC-2569-000002/pdf');
      expect(r.status()).toBe(200);
      expect(r.headers()['content-type']).toContain('application/pdf');
      expect(dispositionName(r.headers()['content-disposition'])).toBe('DOC-2569-000002.pdf');
      const body = await r.body();
      expect(
        await pdfHasLine(body, `docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=${code} validUntil=2027-02-28`),
      ).toBe(true);
    });

    await test.step('/verify/<code> แสดงข้อมูลเอกสาร', async () => {
      const anon = await asAnon(browser);
      const p = anon.page;
      await expectVerify(p, code, 'VALID', '2027-02-28');
      await expect(tid(p, 'verify-doc-no')).toHaveText('DOC-2569-000002');
      await expect(tid(p, 'verify-applicant')).toHaveText('สมหญิง ร***');
      await expect(tid(p, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
      await expect(tid(p, 'verify-issued')).toHaveAttribute('data-iso', T0);
      await expect(tid(p, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 2');
      const j = await expectApi(await anon.api.get(`/api/verify/${code}`), 200);
      expect(j.result).toBe('VALID');
      expect(j.validUntil).toBe('2027-02-28');
      expect(j.issuedAt).toBe(T0);
    });

    await test.step('หน้าเคส doc-qr', async () => {
      await open(reg2.page, `/officer/cases/${cn(25)}`);
      await expect(tid(reg2.page, 'doc-qr')).toHaveAttribute('data-url', `${BASE_URL}/verify/${code}`);
    });

    await test.step('สมชาย (ไม่ใช่ผู้ยื่น) → 404', async () => {
      const sc = await asCitizen(browser, ID.somchai);
      expect((await sc.api.get('/api/documents/DOC-2569-000002/pdf')).status()).toBe(404);
    });

    await test.step('ออกซ้ำ → 409 · เลขถัดไปยัง DOC-2569-000003', async () => {
      await expectApi(await reg2.api.post(`/api/officer/cases/${cn(25)}/issue`), 409, 'INVALID_STATE');
      const reg1 = await asStaff(browser, 'off.reg1');
      await issue19(reg1, 'DOC-2569-000003');
    });
  });

  test('TC-DOC-02 · ตรวจเอกสาร /verify', async ({ browser }) => {
    await reset();
    const anon = await asAnon(browser);
    const p = anon.page;

    await test.step('/verify/K7M2Q9XA → VALID', async () => {
      await expectVerify(p, 'K7M2Q9XA', 'VALID', '2027-02-02');
      expect(new URL(p.url()).pathname).not.toBe('/login');
      await expect(tid(p, 'verify-doc-no')).toHaveText('DOC-2569-000001');
      await expect(tid(p, 'verify-applicant')).toHaveText('สมชาย ใ***');
      await expect(tid(p, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
      await expect(tid(p, 'verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
      await expect(tid(p, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 1');
      const text = await p.locator('body').innerText();
      expect(text).not.toContain('ใจดี');
      expect(text).not.toContain('1101700123456');
      expect(await p.content()).not.toContain('1101700123456');
    });

    await test.step('/verify/ZZZZZZZZ → 404 NOT_FOUND', async () => {
      await expectVerify(p, 'ZZZZZZZZ', 'NOT_FOUND');
    });

    await test.step('API', async () => {
      const ok = await expectApi(await anon.api.get('/api/verify/K7M2Q9XA'), 200);
      expect(ok.result).toBe('VALID');
      expect(ok.applicantMasked).toBe('สมชาย ใ***');
      expect(JSON.stringify(ok)).not.toContain('ใจดี');
      expect(JSON.stringify(ok)).not.toContain('1101700123456');
      const nf = await anon.api.get('/api/verify/ZZZZZZZZ');
      expect(nf.status()).toBe(404);
      expect(await nf.json()).toEqual({ result: 'NOT_FOUND' });
    });
  });

  test('TC-DOC-03 · เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ browser }) => {
    await test.step('ส่วน A · SV-01 ออก 1 ธ.ค. 69 · 90 วัน', async () => {
      await reset();
      const reg2 = await asStaff(browser, 'off.reg2');
      const c1 = await approveIssue25(reg2, 'DOC-2569-000002');
      const anon = await asAnon(browser);
      await setClock('2027-02-28T23:59:00+07:00');
      await expectVerify(anon.page, c1, 'VALID', '2027-02-28');
      await setClock('2027-03-01T00:00:00+07:00');
      await expectVerify(anon.page, c1, 'EXPIRED', '2027-02-28');
    });

    await test.step('ส่วน B · SV-02 ออก 1 ธ.ค. 69 · 1 ปี', async () => {
      await reset();
      const reg1 = await asStaff(browser, 'off.reg1');
      const c2 = await issue19(reg1, 'DOC-2569-000002');
      const anon = await asAnon(browser);
      await setClock('2027-11-30T23:59:00+07:00');
      await expectVerify(anon.page, c2, 'VALID', '2027-11-30');
      await setClock('2027-12-01T00:00:00+07:00');
      await expectVerify(anon.page, c2, 'EXPIRED', '2027-11-30');
    });

    await test.step('ส่วน C · seed K7M2Q9XA ใช้ได้ถึง 2 ก.พ. 70', async () => {
      await reset();
      const anon = await asAnon(browser);
      await setClock('2027-02-02T23:59:00+07:00');
      await expectVerify(anon.page, 'K7M2Q9XA', 'VALID', '2027-02-02');
      await setClock('2027-02-03T00:00:00+07:00');
      await expectVerify(anon.page, 'K7M2Q9XA', 'EXPIRED', '2027-02-02');
    });

    await test.step('ส่วน E · ออกวันที่ 29 ก.พ. 2571', async () => {
      await reset();
      await setClock('2028-02-29T10:00:00+07:00');
      const reg2 = await asStaff(browser, 'off.reg2');
      const reg1 = await asStaff(browser, 'off.reg1');
      const e1 = await approveIssue25(reg2, 'DOC-2571-000001');
      const e2 = await issue19(reg1, 'DOC-2571-000002');
      const anon = await asAnon(browser);
      await setClock('2028-05-28T23:59:00+07:00');
      await expectVerify(anon.page, e1, 'VALID', '2028-05-28');
      await setClock('2028-05-29T00:00:00+07:00');
      await expectVerify(anon.page, e1, 'EXPIRED', '2028-05-28');
      await setClock('2029-02-27T23:59:00+07:00');
      await expectVerify(anon.page, e2, 'VALID', '2029-02-27');
      await setClock('2029-02-28T00:00:00+07:00');
      await expectVerify(anon.page, e2, 'EXPIRED', '2029-02-27');
    });

    await test.step('ส่วน D · ลายเซ็นไม่ตรง', async () => {
      await reset();
      const anon = await asAnon(browser);
      const t = await expectApi(await anon.api.post('/api/test/documents/DOC-2569-000001/tamper'), 200);
      expect(t).toEqual({ ok: true });
      await expectVerify(anon.page, 'K7M2Q9XA', 'TAMPERED');
      await setClock('2027-03-01T00:00:00+07:00');
      await expectVerify(anon.page, 'K7M2Q9XA', 'TAMPERED');
    });
  });
});

// ═════════════════════════════════ §12 PDPA ═════════════════════════════════

test.describe('§12 PDPA', () => {
  test('TC-PDPA-01 · ปิดบังเลขบัตรบนจอ', async ({ browser }) => {
    await reset();
    const reg2 = await asStaff(browser, 'off.reg2');
    const p = reg2.page;

    await test.step('off.reg2 /officer/queue', async () => {
      await open(p, '/officer/queue');
      const cells = tid(tid(p, 'queue-row'), 'row-id-masked');
      await expect(cells).not.toHaveCount(0);
      for (const t of await cells.allTextContents()) expect(t.trim()).toMatch(MASKED_RE);
      const r25 = p.locator(`[data-testid="queue-row"][data-case-no="${cn(25)}"]`);
      const r26 = p.locator(`[data-testid="queue-row"][data-case-no="${cn(26)}"]`);
      await expect(tid(r25, 'row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9');
      await expect(tid(r26, 'row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6');
    });

    await test.step('off.reg2 /officer/cases/…000025', async () => {
      await open(p, `/officer/cases/${cn(25)}`);
      await expect(tid(p, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
      const html = await p.content();
      expect(html).not.toContain('3100600987659');
      expect(html).not.toContain('3-1006-00987-65-9');
    });

    await test.step('head1 /officer/cases/…000025', async () => {
      const head = await asStaff(browser, 'head1');
      await open(head.page, `/officer/cases/${cn(25)}`);
      await expect(tid(head.page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    });

    await test.step('ประชาชนเห็นเลขของตัวเองเต็ม', async () => {
      const sy = await asCitizen(browser, ID.somying);
      await open(sy.page, `/citizen/cases/${cn(25)}`);
      await expect(tid(sy.page, 'case-id-full')).toHaveText('3-1006-00987-65-9');
      const sc = await asCitizen(browser, ID.somchai);
      await open(sc.page, `/citizen/cases/${cn(20)}`);
      await expect(tid(sc.page, 'case-id-full')).toHaveText('1-1017-00123-45-6');
    });
  });

  test('TC-PDPA-02 · API (JSON) ไม่ส่งเลขบัตรเต็ม (B09)', async ({ browser }) => {
    await reset();
    const endpoints = [
      '/api/officer/queue?filter=all',
      `/api/cases/${cn(25)}`,
      `/api/cases/${cn(26)}`,
      `/api/cases/${cn(20)}`,
      '/api/notifications',
      `/api/cases/${cn(25)}/files`,
    ];
    for (const user of ['off.reg1', 'head1']) {
      const s = await asStaff(browser, user);
      for (const ep of endpoints) {
        await test.step(`${user} GET ${ep}`, async () => {
          const r = await s.api.get(ep);
          expect(r.status(), ep).toBe(200);
          expect(r.headers()['content-type'] ?? '').toContain('application/json');
          const body = await r.json();
          const str = JSON.stringify(body);
          expect.soft(str, `${user} ${ep}: \\d{13}`).not.toMatch(/\d{13}/);
          expect.soft(str, `${user} ${ep}: d-dddd-ddddd-dd-d`).not.toMatch(/\d-\d{4}-\d{5}-\d{2}-\d/);
          expect.soft(findKeysDeep(body, 'idNo'), `${user} ${ep}: key idNo`).toEqual([]);
          for (const pii of PII_IDS.slice(0, 3)) expect.soft(str, `${user} ${ep}: ${pii}`).not.toContain(pii);
          if (ep.startsWith('/api/officer/queue')) {
            expect(Array.isArray(body.items) && body.items.length > 0).toBe(true);
            for (const it of body.items) expect.soft(it.idMasked, `${user} queue ${it.caseNo}`).toMatch(MASKED_RE);
          } else if (Array.isArray(body.items)) {
            for (const it of body.items)
              if ('idMasked' in it) expect.soft(it.idMasked, `${user} ${ep}`).toMatch(MASKED_RE);
          } else if (/^\/api\/cases\/[^/]+$/.test(ep)) {
            expect.soft(body.idMasked, `${user} ${ep} idMasked`).toMatch(MASKED_RE);
          }
        });
      }
    }
  });

  test('TC-PDPA-03 · แสดงเลขเต็มต้องมีเหตุผลและบันทึก Audit (B11)', async ({ browser }) => {
    const C25 = cn(25);
    await reset();
    const reg2 = await asStaff(browser, 'off.reg2');
    const p = reg2.page;
    await open(p, `/officer/cases/${C25}`);

    await test.step('1 เหตุผลว่าง', async () => {
      await tid(p, 'show-full-id-btn').click();
      await tid(p, 'unmask-reason').fill('');
      await act(p, tid(p, 'unmask-submit'));
      await expect(tid(p, 'unmask-error')).toHaveText(MSG.REASON_REQUIRED);
      await expectCount(p, 'full-id', 0);
      await expectApi(
        await reg2.api.post(`/api/officer/cases/${C25}/unmask`, { data: { reason: '' } }),
        400,
        'REASON_REQUIRED',
        MSG.REASON_REQUIRED,
      );
    });

    await test.step('2 เหตุผลเว้นวรรคล้วน', async () => {
      await submitReason(p, UNMASK_IDS, '     ');
      await expect(tid(p, 'unmask-error')).toHaveText(MSG.REASON_REQUIRED);
      await expectCount(p, 'full-id', 0);
      await expectApi(
        await reg2.api.post(`/api/officer/cases/${C25}/unmask`, { data: { reason: '     ' } }),
        400,
        'REASON_REQUIRED',
      );
    });

    await test.step('3 เหตุผลถูกต้อง', async () => {
      await submitReason(p, UNMASK_IDS, 'ตรวจสอบตัวตนซ้ำ');
      await expect(tid(p, 'full-id')).toHaveText('3-1006-00987-65-9');
    });

    await test.step('4 โหลดหน้าซ้ำ', async () => {
      await p.reload();
      await expect(tid(p, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
      await expectCount(p, 'full-id', 0);
    });

    await test.step('5 audit1 เห็น UNMASK 1 แถว', async () => {
      const au = await asStaff(browser, 'audit1');
      await open(au.page, '/audit');
      await auditFilterUI(au.page, { event: 'UNMASK' });
      await expect(tid(au.page, 'audit-count')).toHaveText('1');
      const row = tid(au.page, 'audit-row');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-actor', 'off.reg2');
      await expect(tid(row, 'audit-role')).toHaveText('officer');
      await expect(tid(row, 'audit-case-no')).toHaveText(C25);
      await expect(tid(row, 'audit-event')).toHaveText('UNMASK');
      await expect(tid(row, 'audit-detail')).toContainText('ตรวจสอบตัวตนซ้ำ');
      await expect(tid(row, 'audit-time')).toHaveAttribute('data-iso', T0);
      const a = await auditApi(au.api, { event: 'UNMASK' });
      expect(a.count).toBe(1);
    });

    await test.step('6 exec1 audit1 สมหญิง → 403', async () => {
      for (const who of ['exec1', 'audit1']) {
        const s = await asStaff(browser, who);
        await expectApi(await s.api.post(`/api/officer/cases/${C25}/unmask`, { data: { reason: 'x' } }), 403);
      }
      const sy = await asCitizen(browser, ID.somying);
      await expectApi(await sy.api.post(`/api/officer/cases/${C25}/unmask`, { data: { reason: 'x' } }), 403);
    });
  });
});

// ═════════════════════════════════ §13 DASH ═════════════════════════════════

type Kpi = { received: string; closed: string; ontime: string; backlog: string; overdue: string };

async function expectKpiUI(page: Page, k: Partial<Kpi>): Promise<void> {
  if (k.received !== undefined) await expect(tid(page, 'kpi-received')).toHaveText(k.received);
  if (k.closed !== undefined) await expect(tid(page, 'kpi-closed')).toHaveText(k.closed);
  if (k.ontime !== undefined) await expect(tid(page, 'kpi-ontime-pct')).toHaveText(k.ontime);
  if (k.backlog !== undefined) await expect(tid(page, 'kpi-backlog')).toHaveText(k.backlog);
  if (k.overdue !== undefined) await expect(tid(page, 'kpi-overdue')).toHaveText(k.overdue);
}

const pctNum = (s: string) => (s === '–' ? null : Number(s.replace('%', '')));

test.describe('§13 DASH', () => {
  test('TC-DASH-01 · Dashboard ตัวเลขเริ่มต้น', async ({ browser }) => {
    await reset();
    const ex = await asStaff(browser, 'exec1');
    const p = ex.page;
    await open(p, '/dashboard');

    await test.step('ค่าเริ่มต้น 2026-12 / ALL', async () => {
      await expect(tid(p, 'period-select')).toHaveValue('2026-12');
      await expect(tid(p, 'service-select')).toHaveValue('ALL');
      await expectKpiUI(p, { received: '3', closed: '0', ontime: '–', backlog: '21', overdue: '1' });
      const d = await dashApi(ex.api, '2026-12', 'ALL');
      expect(d.received).toBe(3);
      expect(d.closed).toBe(0);
      expect(d.ontimePct).toBeNull();
      expect(d.backlog).toBe(21);
      expect(d.overdue).toBe(1);
      const wl = Object.fromEntries((d.workload as any[]).map((w) => [w.username, w.count]));
      expect(wl).toEqual({ 'off.reg1': 3, 'off.reg2': 9, 'off.works1': 0 });
    });

    await test.step('workload-row 3 แถว', async () => {
      await expectCount(p, 'workload-row', 3);
      for (const [u, v] of [['off.reg1', '3'], ['off.reg2', '9'], ['off.works1', '0']]) {
        const row = p.locator(`[data-testid="workload-row"][data-username="${u}"]`);
        await expect(tid(row, 'workload-value')).toHaveText(v);
      }
    });

    await test.step('ไม่มีข้อมูลส่วนบุคคล', async () => {
      expectNoPII(await p.locator('body').innerText(), '/dashboard');
    });

    await test.step('ตัวกรองบริการ', async () => {
      const rows: [string, Kpi][] = [
        ['SV-01', { received: '3', closed: '0', ontime: '–', backlog: '11', overdue: '1' }],
        ['SV-02', { received: '0', closed: '0', ontime: '–', backlog: '7', overdue: '0' }],
        ['SV-03', { received: '0', closed: '0', ontime: '–', backlog: '3', overdue: '0' }],
      ];
      for (const [svc, k] of rows) {
        await selectSettle(p, 'service-select', svc);
        await expect(tid(p, 'period-select')).toHaveValue('2026-12');
        await expectKpiUI(p, k);
        const d = await dashApi(ex.api, '2026-12', svc);
        expect.soft([d.received, d.closed, d.ontimePct, d.backlog, d.overdue], svc).toEqual([
          Number(k.received), Number(k.closed), null, Number(k.backlog), Number(k.overdue),
        ]);
      }
    });
  });

  test('TC-DASH-02 · Dashboard ย้อนหลัง (B10)', async ({ browser }) => {
    await reset();
    const ex = await asStaff(browser, 'exec1');
    const p = ex.page;
    await open(p, '/dashboard');
    const NOW: Record<string, [string, string]> = {
      ALL: ['21', '1'], 'SV-01': ['11', '1'], 'SV-02': ['7', '0'], 'SV-03': ['3', '0'],
    };
    const rows: [string, string, string, string, string][] = [
      ['2026-10', 'ALL', '1', '1', '100.0%'],
      ['2026-11', 'ALL', '26', '7', '85.7%'],
      ['2026-11', 'SV-01', '12', '3', '100.0%'],
      ['2026-11', 'SV-02', '10', '3', '66.7%'],
      ['2026-11', 'SV-03', '4', '1', '100.0%'],
      ['2026', 'ALL', '30', '8', '87.5%'],
      ['2026', 'SV-01', '16', '4', '100.0%'],
      ['2026', 'SV-02', '10', '3', '66.7%'],
      ['2026', 'SV-03', '4', '1', '100.0%'],
    ];
    for (const [period, svc, rec, closed, pct] of rows) {
      await test.step(`${period} / ${svc}`, async () => {
        await selectSettle(p, 'period-select', period);
        await selectSettle(p, 'service-select', svc);
        await expect(tid(p, 'period-select')).toHaveValue(period);
        const [backlog, overdue] = NOW[svc];
        await expectKpiUI(p, { received: rec, closed, ontime: pct, backlog, overdue });
        const d = await dashApi(ex.api, period, svc);
        expect.soft(d.received, `${period} ${svc} received`).toBe(Number(rec));
        expect.soft(d.closed, `${period} ${svc} closed`).toBe(Number(closed));
        expect.soft(d.ontimePct, `${period} ${svc} ontimePct`).toBe(pctNum(pct));
        expect.soft(d.backlog, `${period} ${svc} backlog`).toBe(Number(backlog));
        expect.soft(d.overdue, `${period} ${svc} overdue`).toBe(Number(overdue));
      });
    }
  });

  test('TC-DASH-03 · ส่งออก Excel/PDF เท่าหน้าจอ', async ({ browser }) => {
    await reset();
    const ex = await asStaff(browser, 'exec1');
    const p = ex.page;
    await open(p, '/dashboard');
    const LABELS = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];

    async function checkXlsx(expected: string[], label: string) {
      const f = await grab(p, tid(p, 'export-xlsx-btn'));
      const rows = await xlsxFirstSheet(f.body);
      expect(rows[0]?.slice(0, 2), `${label} header`).toEqual(['ตัวชี้วัด', 'ค่า']);
      for (let i = 0; i < 5; i++) {
        expect.soft(rows[i + 1]?.[0], `${label} A${i + 2}`).toBe(LABELS[i]);
        expect.soft(rows[i + 1]?.[1], `${label} B${i + 2}`).toBe(expected[i]);
      }
      // เท่ากับ 5 ช่องบนจอ
      const screen = [
        await tid(p, 'kpi-received').innerText(),
        await tid(p, 'kpi-closed').innerText(),
        await tid(p, 'kpi-ontime-pct').innerText(),
        await tid(p, 'kpi-backlog').innerText(),
        await tid(p, 'kpi-overdue').innerText(),
      ].map((s) => s.trim());
      expect.soft(rows.slice(1, 6).map((r) => r?.[1]), `${label} = จอ`).toEqual(screen);
      expectNoPII(rows.map((r) => r.join('\t')).join('\n'), label);
    }

    await test.step('พ.ย. / ALL → xlsx', async () => {
      await selectSettle(p, 'period-select', '2026-11');
      await selectSettle(p, 'service-select', 'ALL');
      await expectKpiUI(p, { received: '26', closed: '7', ontime: '85.7%', backlog: '21', overdue: '1' });
      await checkXlsx(['26', '7', '85.7%', '21', '1'], 'xlsx พ.ย.');
    });

    await test.step('พ.ย. / ALL → pdf', async () => {
      const f = await grab(p, tid(p, 'export-pdf-btn'));
      if (f.contentType) expect(f.contentType).toContain('application/pdf');
      expect(f.body.subarray(0, 4).toString('latin1')).toBe('%PDF');
      expect(await pdfHasLine(f.body, 'kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1')).toBe(true);
      expectNoPII(await pdfText(f.body), 'pdf พ.ย.');
    });

    await test.step('ธ.ค. / ALL → xlsx', async () => {
      await selectSettle(p, 'period-select', '2026-12');
      await selectSettle(p, 'service-select', 'ALL');
      await expectKpiUI(p, { received: '3', closed: '0', ontime: '–', backlog: '21', overdue: '1' });
      await checkXlsx(['3', '0', '–', '21', '1'], 'xlsx ธ.ค.');
    });

    await test.step('Audit EXPORT 3 แถว', async () => {
      const au = await asStaff(browser, 'audit1');
      const a = await auditApi(au.api, { event: 'EXPORT' });
      expect(a.count).toBe(3);
      for (const it of a.items) {
        expect(it.username).toBe('exec1');
        expect(it.role).toBe('executive');
      }
      const details: string[] = a.items.map((i: any) => String(i.detail ?? ''));
      for (const [fmt, per] of [['xlsx', '2026-11'], ['pdf', '2026-11'], ['xlsx', '2026-12']]) {
        expect(details.some((d) => d.includes(fmt) && d.includes(per)), `EXPORT ${fmt} ${per}`).toBe(true);
      }
      await open(au.page, '/audit');
      await auditFilterUI(au.page, { event: 'EXPORT' });
      await expect(tid(au.page, 'audit-count')).toHaveText('3');
      for (const a2 of await attrs(tid(au.page, 'audit-row'), 'data-actor')) expect(a2).toBe('exec1');
      for (const r of await tid(au.page, 'audit-role').allTextContents()) expect(r.trim()).toBe('executive');
    });
  });

  test('TC-DASH-04 · ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ browser }) => {
    await reset();
    await setClock('2026-12-03T16:00:00+07:00');
    const reg1 = await asStaff(browser, 'off.reg1');
    const reg2 = await asStaff(browser, 'off.reg2');
    const ex = await asStaff(browser, 'exec1');

    async function checkDash(closed: number, onTime: number) {
      const d = await dashApi(ex.api, '2026-12');
      expect(d.closed, 'closed').toBe(closed);
      expect(d.onTime, 'onTime').toBe(onTime);
      await open(ex.page, '/dashboard');
      await expect(tid(ex.page, 'kpi-closed')).toHaveText(String(closed));
    }
    async function closedAt(a: Actor, caseNo: string, iso: string) {
      await open(a.page, `/officer/cases/${caseNo}`);
      await expect(tid(a.page, 'closed-at')).toHaveAttribute('data-iso', iso);
      expect((await getCase(a.api, caseNo)).closedAt).toBe(iso);
    }

    await test.step('1 16:00 approve …000025 และ …000023', async () => {
      expect((await expectApi(await reg2.api.post(`/api/cases/${cn(25)}/approve`), 200)).status).toBe('APPROVED');
      expect((await expectApi(await reg1.api.post(`/api/cases/${cn(23)}/approve`), 200)).status).toBe('APPROVED');
    });

    await test.step('2 16:29:59 issue …000025 → ทัน', async () => {
      await setClock('2026-12-03T16:29:59+07:00');
      expect((await expectApi(await reg2.api.post(`/api/officer/cases/${cn(25)}/issue`), 200)).status).toBe('COMPLETED');
      await closedAt(reg2, cn(25), '2026-12-03T16:29:59+07:00');
      await checkDash(1, 1);
    });

    await test.step('3 16:30:00 reject …000026 → ทัน (ที่ขอบ)', async () => {
      await setClock('2026-12-03T16:30:00+07:00');
      const r = await expectApi(await reg2.api.post(`/api/cases/${cn(26)}/reject`, { data: { reason: X10 } }), 200);
      expect(r.status).toBe('REJECTED');
      await closedAt(reg2, cn(26), '2026-12-03T16:30:00+07:00');
      await checkDash(2, 2);
    });

    await test.step('4 16:30:01 issue …000023 → ไม่ทัน', async () => {
      await setClock('2026-12-03T16:30:01+07:00');
      expect((await expectApi(await reg1.api.post(`/api/officer/cases/${cn(23)}/issue`), 200)).status).toBe('COMPLETED');
      await closedAt(reg1, cn(23), '2026-12-03T16:30:01+07:00');
      await checkDash(3, 2);
      expect((await dashApi(ex.api, '2026-12')).backlog).toBe(18);
      await expect(tid(ex.page, 'kpi-backlog')).toHaveText('18');
    });
  });
});

// ═════════════════════════════════ §14 AUDIT ═════════════════════════════════

test.describe('§14 AUDIT', () => {
  test('TC-AUDIT-01 · เหตุการณ์และฟิลด์ใน Audit (B11)', async ({ browser }) => {
    await reset();
    // ล็อกอินครั้งเดียวต่อบัญชี แล้วใช้ context เดิมซ้ำ
    const reg2 = await asStaff(browser, 'off.reg2');
    await expectApi(await reg2.api.post(`/api/officer/cases/${cn(28)}/claim`), 200);
    const reg1 = await asStaff(browser, 'off.reg1');
    await expectApi(await reg1.api.post(`/api/officer/cases/${cn(20)}/return`, { data: { reason: X10 } }), 200);
    await expectApi(await reg2.api.post(`/api/officer/cases/${cn(13)}/forward`), 200);
    const head = await asStaff(browser, 'head1');
    await expectApi(await head.api.post(`/api/cases/${cn(13)}/approve`), 200);
    await expectApi(await reg2.api.post(`/api/cases/${cn(25)}/approve`), 200);
    await expectApi(await reg2.api.post(`/api/officer/cases/${cn(25)}/issue`), 200);
    await expectApi(await reg2.api.post(`/api/cases/${cn(26)}/reject`, { data: { reason: X10 } }), 200);
    await expectApi(
      await reg2.api.post(`/api/officer/cases/${cn(25)}/unmask`, { data: { reason: 'ตรวจสอบตัวตนซ้ำ' } }),
      200,
    );
    const ex = await asStaff(browser, 'exec1');
    expect((await ex.api.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL')).status()).toBe(200);
    const ad = await asStaff(browser, 'admin1');
    await expectApi(await ad.api.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } }), 200);
    const au = await asStaff(browser, 'audit1');
    const p = au.page;
    await open(p, '/audit');

    // ลำดับที่คาด (ใหม่ → เก่า · เวลาเท่ากันเรียง id มาก → น้อย)
    const EXPECTED: { event: string; actor: string; role: string; caseNo?: string; tr: string; detail?: string[] }[] = [
      { event: 'STAFF_LOGIN', actor: 'audit1', role: 'auditor', tr: '–' },
      { event: 'ADMIN_CHANGE', actor: 'admin1', role: 'admin', tr: '–', detail: ['SV-01 fee 20 → 25'] },
      { event: 'STAFF_LOGIN', actor: 'admin1', role: 'admin', tr: '–' },
      { event: 'EXPORT', actor: 'exec1', role: 'executive', tr: '–', detail: ['xlsx', '2026-12'] },
      { event: 'STAFF_LOGIN', actor: 'exec1', role: 'executive', tr: '–' },
      { event: 'UNMASK', actor: 'off.reg2', role: 'officer', caseNo: cn(25), tr: '–', detail: ['ตรวจสอบตัวตนซ้ำ'] },
      { event: 'REJECT', actor: 'off.reg2', role: 'officer', caseNo: cn(26), tr: 'IN_REVIEW → REJECTED', detail: [X10] },
      { event: 'ISSUE', actor: 'off.reg2', role: 'officer', caseNo: cn(25), tr: 'APPROVED → COMPLETED', detail: ['DOC-2569-000002'] },
      { event: 'APPROVE', actor: 'off.reg2', role: 'officer', caseNo: cn(25), tr: 'IN_REVIEW → APPROVED' },
      { event: 'APPROVE', actor: 'head1', role: 'head', caseNo: cn(13), tr: 'PENDING_APPROVAL → APPROVED' },
      { event: 'STAFF_LOGIN', actor: 'head1', role: 'head', tr: '–' },
      { event: 'FORWARD', actor: 'off.reg2', role: 'officer', caseNo: cn(13), tr: 'IN_REVIEW → PENDING_APPROVAL' },
      { event: 'RETURN', actor: 'off.reg1', role: 'officer', caseNo: cn(20), tr: 'IN_REVIEW → NEED_FIX', detail: [X10] },
      { event: 'STAFF_LOGIN', actor: 'off.reg1', role: 'officer', tr: '–' },
      { event: 'CLAIM', actor: 'off.reg2', role: 'officer', caseNo: cn(28), tr: 'SUBMITTED → IN_REVIEW' },
      { event: 'STAFF_LOGIN', actor: 'off.reg2', role: 'officer', tr: '–' },
    ];

    await test.step('ไม่กรอง: 16 แถว ครบทุกฟิลด์', async () => {
      await expect(tid(p, 'audit-count')).toHaveText('16');
      const rows = tid(p, 'audit-row');
      await expect(rows).toHaveCount(16);
      const ids = (await attrs(rows, 'data-id')).map(Number);
      expect(ids, 'data-id มาก → น้อย').toEqual([...ids].sort((a, b) => b - a));
      for (let i = 0; i < EXPECTED.length; i++) {
        const e = EXPECTED[i];
        const r = rows.nth(i);
        const tag = `แถว ${i + 1} ${e.event} ${e.actor}`;
        await expect.soft(r, tag).toHaveAttribute('data-event', e.event);
        await expect.soft(r, tag).toHaveAttribute('data-actor', e.actor);
        await expect.soft(tid(r, 'audit-event'), tag).toHaveText(e.event);
        await expect.soft(tid(r, 'audit-actor'), tag).toHaveText(e.actor);
        await expect.soft(tid(r, 'audit-role'), tag).toHaveText(e.role);
        await expect.soft(tid(r, 'audit-transition'), tag).toHaveText(e.tr);
        await expect.soft(tid(r, 'audit-time'), tag).toHaveAttribute('data-iso', T0);
        if (e.caseNo) {
          await expect.soft(tid(r, 'audit-case-no'), tag).toHaveText(e.caseNo);
          await expect.soft(r, tag).toHaveAttribute('data-case-no', e.caseNo);
        }
        for (const d of e.detail ?? []) await expect.soft(tid(r, 'audit-detail'), tag).toContainText(d);
      }
      // API ให้ผลเดียวกัน
      const a = await auditApi(au.api);
      expect(a.count).toBe(16);
      expect(a.items.map((i: any) => `${i.event}:${i.username}`)).toEqual(EXPECTED.map((e) => `${e.event}:${e.actor}`));
      for (const it of a.items) expect.soft(it.time, `${it.event} time`).toBe(T0);
    });

    await test.step('กรอง', async () => {
      await auditFilterUI(p, { actor: 'off.reg2' });
      await expect(tid(p, 'audit-count')).toHaveText('7');
      expect((await attrs(tid(p, 'audit-row'), 'data-event')).sort()).toEqual(
        ['STAFF_LOGIN', 'CLAIM', 'FORWARD', 'APPROVE', 'ISSUE', 'REJECT', 'UNMASK'].sort(),
      );
      await auditFilterUI(p, { event: 'APPROVE' });
      await expect(tid(p, 'audit-count')).toHaveText('2');
      expect((await attrs(tid(p, 'audit-row'), 'data-actor')).sort()).toEqual(['head1', 'off.reg2']);
      await auditFilterUI(p, { actor: 'off.reg2', event: 'APPROVE' });
      await expect(tid(p, 'audit-count')).toHaveText('1');
      expect((await auditApi(au.api, { actor: 'off.reg2' })).count).toBe(7);
      expect((await auditApi(au.api, { event: 'APPROVE' })).count).toBe(2);
      expect((await auditApi(au.api, { actor: 'off.reg2', event: 'APPROVE' })).count).toBe(1);
    });

    await test.step('CSV', async () => {
      await auditFilterUI(p, {});
      await expect(tid(p, 'audit-count')).toHaveText('16');
      const f = await grab(p, tid(p, 'audit-export-csv-btn'));
      const rows = parseCsv(f.body.toString('utf8'));
      expect(rows[0].join(',')).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
      expect(rows.length - 1).toBe(16);
      expect(rows.slice(1).map((r) => `${r[3]}:${r[1]}`)).toEqual(EXPECTED.map((e) => `${e.event}:${e.actor}`));
      await open(p, '/audit');
      await expect(tid(p, 'audit-count')).toHaveText('17');
      const top = tid(p, 'audit-row').first();
      await expect(top).toHaveAttribute('data-event', 'EXPORT');
      await expect(top).toHaveAttribute('data-actor', 'audit1');
      await expect(tid(top, 'audit-detail')).toContainText('audit-csv');
    });
  });

  test('TC-AUDIT-02 · Audit แก้/ลบไม่ได้ (405)', async ({ browser }) => {
    await reset();
    const au = await asStaff(browser, 'audit1');
    const before = (await auditApi(au.api)).items as any[];
    expect(before.length).toBeGreaterThanOrEqual(1);
    const id = before[0].id;
    const ad = await asStaff(browser, 'admin1');

    for (const who of [ad, au]) {
      await test.step(`${who.name} PUT/PATCH/DELETE → 405`, async () => {
        await expectApi(await who.api.put(`/api/audit/${id}`, { data: { detail: 'x' } }), 405, 'METHOD_NOT_ALLOWED');
        await expectApi(await who.api.patch(`/api/audit/${id}`, { data: { detail: 'x' } }), 405, 'METHOD_NOT_ALLOWED');
        await expectApi(await who.api.delete(`/api/audit/${id}`), 405, 'METHOD_NOT_ALLOWED');
        await expectApi(await who.api.put('/api/audit', { data: { detail: 'x' } }), 405, 'METHOD_NOT_ALLOWED');
        await expectApi(await who.api.delete('/api/audit'), 405, 'METHOD_NOT_ALLOWED');
        await expectApi(await who.api.delete('/api/audit/999999'), 405, 'METHOD_NOT_ALLOWED');
      });
    }

    await test.step('ข้อมูลเดิมไม่ถูกแก้/หาย · เพิ่มเฉพาะ STAFF_LOGIN ของ admin1', async () => {
      const after = (await auditApi(au.api)).items as any[];
      for (const b of before) expect(after, `แถว ${b.id}`).toContainEqual(b);
      const added = after.filter((a) => !before.some((b) => b.id === a.id));
      expect(added.length).toBe(1);
      expect(added[0].event).toBe('STAFF_LOGIN');
      expect(added[0].username).toBe('admin1');
    });

    await test.step('UI ไม่มีปุ่มแก้/ลบ · admin อ่าน Audit ไม่ได้', async () => {
      await open(au.page, '/audit');
      await expect(tid(au.page, 'audit-row').first()).toBeVisible();
      await expectCount(au.page, 'audit-edit-btn', 0);
      await expectCount(au.page, 'audit-delete-btn', 0);
      await expectApi(await ad.api.get('/api/audit'), 403);
    });
  });

  test('TC-AUDIT-03 · กรองช่วงวันที่ตามเวลาไทย', async ({ browser }) => {
    await reset();
    const L = [
      { t: '2026-11-30T23:59:59+07:00', u: 'off.reg1' },
      { t: '2026-12-01T00:00:00+07:00', u: 'off.reg2' },
      { t: '2026-12-01T23:59:59+07:00', u: 'off.works1' },
      { t: '2026-12-02T00:00:00+07:00', u: 'off.reg1' },
      { t: '2026-12-02T09:00:00+07:00', u: 'audit1' },
    ];
    let au!: Actor;
    for (const l of L) {
      await setClock(l.t);
      const a = await asStaff(browser, l.u);
      if (l.u === 'audit1') au = a;
    }
    const p = au.page;
    await open(p, '/audit');

    const cases: { from: string; to: string; actor?: string; rows: number[] }[] = [
      { from: '2026-12-01', to: '2026-12-01', rows: [2, 3] },
      { from: '2026-11-30', to: '2026-11-30', rows: [1] },
      { from: '2026-11-30', to: '2026-12-01', rows: [1, 2, 3] },
      { from: '2026-12-02', to: '', rows: [4, 5] },
      { from: '', to: '2026-11-30', rows: [1] },
      { from: '2026-12-01', to: '2026-12-02', rows: [2, 3, 4, 5] },
      { from: '2026-12-01', to: '2026-12-01', actor: 'off.reg2', rows: [2] },
    ];
    for (const c of cases) {
      await test.step(`from=${c.from || '(ว่าง)'} to=${c.to || '(ว่าง)'}${c.actor ? ` actor=${c.actor}` : ''}`, async () => {
        // ใหม่ → เก่า
        const exp = [...c.rows].sort((a, b) => b - a).map((i) => L[i - 1]);
        await auditFilterUI(p, { from: c.from, to: c.to, actor: c.actor });
        await expect(tid(p, 'audit-count')).toHaveText(String(c.rows.length));
        expect(await attrs(tid(p, 'audit-time'), 'data-iso')).toEqual(exp.map((e) => e.t));
        expect(await attrs(tid(p, 'audit-row'), 'data-actor')).toEqual(exp.map((e) => e.u));
        const q: Record<string, string> = {};
        if (c.from) q.from = c.from;
        if (c.to) q.to = c.to;
        if (c.actor) q.actor = c.actor;
        const a = await auditApi(au.api, q);
        expect(a.count).toBe(c.rows.length);
        expect(a.items.map((i: any) => i.time)).toEqual(exp.map((e) => e.t));
      });
    }
  });
});

// ═════════════════════════════════ §15 RBAC ═════════════════════════════════

test.describe('§15 RBAC', () => {
  test('TC-RBAC-01 · ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR · B06)', async ({ browser }) => {
    await reset();
    const sy = await asCitizen(browser, ID.somying);
    const p = sy.page;

    await test.step('UI /citizen/cases/…000005 (ของสมชาย) → 404', async () => {
      expect(await open(p, `/citizen/cases/${cn(5)}`)).toBe(404);
      await expect(tid(p, 'not-found-msg')).toHaveText(MSG.NOT_FOUND);
      await expectCount(p, 'case-no', 0);
      await expectCount(p, 'case-status', 0);
      expect(await p.content()).not.toContain('สมชาย');
    });

    await test.step('API ของคนอื่น/ไม่มีจริง → 404 เนื้อหาเหมือนกัน', async () => {
      const r1 = await sy.api.get(`/api/cases/${cn(5)}`);
      expect(r1.status()).toBe(404);
      const t1 = await r1.text();
      expect(JSON.parse(t1)).toEqual({ code: 'NOT_FOUND', message: MSG.NOT_FOUND });
      expect(t1).not.toContain('สมชาย');
      const r2 = await sy.api.get(`/api/cases/${cn(999999)}`);
      expect(r2.status()).toBe(404);
      expect(await r2.text()).toBe(t1);
      expect((await sy.api.get('/api/documents/DOC-2569-000001/pdf')).status()).toBe(404);
      expect((await sy.api.get('/api/drafts/DR-0001')).status()).toBe(404);
      expect((await sy.api.post(`/api/cases/${cn(30)}/cancel`)).status()).toBe(404);
    });

    await test.step('ของตัวเอง → 200 · สมชายเปิดของตัวเอง → 200', async () => {
      expect(await open(p, `/citizen/cases/${cn(7)}`)).toBe(200);
      await expect(tid(p, 'case-no')).toHaveText(cn(7));
      const sc = await asCitizen(browser, ID.somchai);
      expect((await sc.api.get(`/api/cases/${cn(5)}`)).status()).toBe(200);
      // คำขอที่สมหญิงพยายามยกเลิกต้องไม่ถูกยกเลิก
      expect((await getCase(sc.api, cn(30))).status).toBe('SUBMITTED');
    });
  });

  test('TC-RBAC-02 · เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (ตรวจที่ API · B07)', async ({ browser }) => {
    const C13 = cn(13);
    const C14 = cn(14);
    await reset();
    const reg2 = await asStaff(browser, 'off.reg2');

    await test.step('1 off.reg2 approve …000014 (PENDING_APPROVAL) → 403', async () => {
      await expectApi(await reg2.api.post(`/api/cases/${C14}/approve`), 403, 'FORBIDDEN');
      expect((await getCase(reg2.api, C14)).status).toBe('PENDING_APPROVAL');
    });
    await test.step('2 off.reg2 approve …000013 (ตัวเองถือ) → 403', async () => {
      await expectApi(await reg2.api.post(`/api/cases/${C13}/approve`), 403, 'FORBIDDEN');
      expect((await getCase(reg2.api, C13)).status).toBe('IN_REVIEW');
    });
    await test.step('3 off.reg2 reject …000014 → 403', async () => {
      await expectApi(await reg2.api.post(`/api/cases/${C14}/reject`, { data: { reason: X10 } }), 403, 'FORBIDDEN');
      expect((await getCase(reg2.api, C14)).status).toBe('PENDING_APPROVAL');
    });
    await test.step('4 UI ไม่มี approve-btn', async () => {
      for (const c of [C13, C14]) {
        await open(reg2.page, `/officer/cases/${c}`);
        await expect(tid(reg2.page, 'case-no')).toHaveText(c);
        await expectCount(reg2.page, 'approve-btn', 0);
      }
    });
    const head = await asStaff(browser, 'head1');
    await test.step('5 head1 approve SV-01 …000025 → 403', async () => {
      await expectApi(await head.api.post(`/api/cases/${cn(25)}/approve`), 403, 'FORBIDDEN');
      expect((await getCase(head.api, cn(25))).status).toBe('IN_REVIEW');
    });
    await test.step('6 head1 approve …000014 → 200 (ตัวควบคุมบวก)', async () => {
      const r = await expectApi(await head.api.post(`/api/cases/${C14}/approve`), 200);
      expect(r.status).toBe('APPROVED');
    });
    await test.step('7 audit1 เห็น APPROVE 1 แถวของ head1', async () => {
      const au = await asStaff(browser, 'audit1');
      await open(au.page, '/audit');
      await auditFilterUI(au.page, { event: 'APPROVE' });
      await expect(tid(au.page, 'audit-count')).toHaveText('1');
      expect(await attrs(tid(au.page, 'audit-row'), 'data-actor')).toEqual(['head1']);
      const a = await auditApi(au.api, { event: 'APPROVE' });
      expect(a.count).toBe(1);
      expect(a.items[0].username).toBe('head1');
      expect(a.items[0].caseNo).toBe(C14);
    });
  });

  test('TC-RBAC-03 · ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser }) => {
    test.setTimeout(300_000);
    type Role = 'anon' | 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
    const ROLES: Role[] = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
    const ok = 'ok', F = '403', L = 'login';
    // ส่วน A (ลำดับคอลัมน์ตาม ROLES)
    const PAGES: [string, string[]][] = [
      ['/citizen', [L, ok, F, F, F, F, F]],
      ['/officer/queue', [L, F, ok, ok, F, F, F]],
      ['/head/approvals', [L, F, F, ok, F, F, F]],
      ['/dashboard', [L, F, F, F, ok, F, F]],
      ['/audit', [L, F, F, F, F, ok, F]],
      ['/admin/services', [L, F, F, F, F, F, ok]],
      ['/admin/holidays', [L, F, F, F, F, F, ok]],
      ['/admin/users', [L, F, F, F, F, F, ok]],
      ['/notifications', [L, F, ok, ok, F, F, F]],
      ['/verify/K7M2Q9XA', [ok, ok, ok, ok, ok, ok, ok]],
    ];
    // ส่วน B (claim อยู่ท้ายสุด)
    const APIS: [string, string, unknown, number[]][] = [
      ['GET', '/api/officer/queue', undefined, [401, 403, 200, 200, 403, 403, 403]],
      ['GET', '/api/notifications', undefined, [401, 403, 200, 200, 403, 403, 403]],
      ['GET', '/api/dashboard?period=2026-12&service=ALL', undefined, [401, 403, 403, 403, 200, 403, 403]],
      ['GET', '/api/audit', undefined, [401, 403, 403, 403, 403, 200, 403]],
      ['GET', '/api/admin/services', undefined, [401, 403, 403, 403, 403, 403, 200]],
      ['POST', '/api/drafts', { serviceId: 'SV-01', qty: 1 }, [401, 201, 403, 403, 403, 403, 403]],
      ['GET', `/api/cases/${cn(25)}`, undefined, [401, 200, 200, 200, 403, 403, 403]],
      ['POST', `/api/officer/cases/${cn(28)}/claim`, undefined, [401, 403, 200, 403, 403, 403, 403]],
    ];
    // ส่วน D
    const NAV_ALL = [
      'nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-dashboard', 'nav-audit',
      'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users', 'nav-bell',
    ];
    const NAV: Record<Role, string[]> = {
      anon: [],
      citizen: ['nav-my-cases'],
      officer: ['nav-queue', 'nav-bell'],
      head: ['nav-queue', 'nav-approvals', 'nav-bell'],
      executive: ['nav-dashboard'],
      auditor: ['nav-audit'],
      admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
    };
    const LANDING: Record<Role, string> = {
      anon: '/login', citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals',
      executive: '/dashboard', auditor: '/audit', admin: '/admin/services',
    };
    const STAFF: Partial<Record<Role, string>> = {
      officer: 'off.reg1', head: 'head1', executive: 'exec1', auditor: 'audit1', admin: 'admin1',
    };

    for (const [ri, role] of ROLES.entries()) {
      await test.step(`บทบาท ${role}`, async () => {
        await reset();
        const a =
          role === 'anon'
            ? await asAnon(browser)
            : role === 'citizen'
              ? await asCitizen(browser, ID.somchai)
              : await asStaff(browser, STAFF[role]!);
        const p = a.page;

        // ส่วน D เมนู
        if (role !== 'anon') {
          await open(p, LANDING[role]);
          for (const n of NAV_ALL) {
            await expect.soft(tid(p, n), `${role} ${n}`).toHaveCount(NAV[role].includes(n) ? 1 : 0);
          }
        }

        // ส่วน A หน้า
        for (const [path, exp] of PAGES) {
          const want = exp[ri];
          const status = await open(p, path);
          const pathname = new URL(p.url()).pathname;
          const tag = `${role} ${path}`;
          if (want === L) {
            expect.soft(pathname, `${tag} → /login`).toBe('/login');
          } else if (want === F) {
            expect.soft(status, `${tag} HTTP`).toBe(403);
            await expect.soft(tid(p, 'forbidden-msg'), tag).toHaveText(MSG.FORBIDDEN_PAGE);
          } else {
            expect.soft(status, `${tag} HTTP`).toBe(200);
            expect.soft(pathname, `${tag} ไม่ redirect`).toBe(path);
            await expect.soft(tid(p, 'forbidden-msg'), tag).toHaveCount(0);
          }
        }

        // ส่วน B API
        const somying = role === 'citizen' ? await asCitizen(browser, ID.somying) : null;
        for (const [method, url, body, exp] of APIS) {
          const api = role === 'citizen' && url === `/api/cases/${cn(25)}` ? somying!.api : a.api;
          const r = method === 'GET' ? await api.get(url) : await api.post(url, body ? { data: body } : undefined);
          expect.soft(r.status(), `${role} ${method} ${url}`).toBe(exp[ri]);
          if (exp[ri] === 401) expect.soft((await json(r))?.code, `${role} ${url} code`).toBe('UNAUTHENTICATED');
          if (exp[ri] === 403) expect.soft((await json(r))?.code, `${role} ${url} code`).toBe('FORBIDDEN');
        }
      });
    }

    await test.step('ส่วน C ขอบเขตแผนก', async () => {
      await reset();
      const works = await asStaff(browser, 'off.works1');
      const reg1 = await asStaff(browser, 'off.reg1');
      await expectApi(await works.api.post(`/api/officer/cases/${cn(28)}/claim`), 403, 'FORBIDDEN');
      await expectApi(await reg1.api.post(`/api/officer/cases/${cn(10)}/claim`), 403, 'FORBIDDEN');
      const q = await expectApi(await works.api.get('/api/officer/queue?filter=all'), 200);
      expect(q.items.map((i: any) => i.caseNo)).toEqual([cn(10)]);
      await open(works.page, '/officer/queue');
      expect(await attrs(tid(works.page, 'queue-row'), 'data-case-no')).toEqual([cn(10)]);
    });
  });

  test('TC-RBAC-04 · ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ browser }) => {
    test.setTimeout(240_000);
    await reset();
    const ad = await asStaff(browser, 'admin1');
    const ap = ad.page;
    const HOLIDAYS = ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01'];

    await test.step('1 วันหยุดเริ่มต้น 4 วัน', async () => {
      await open(ap, '/admin/holidays');
      await expectCount(ap, 'holiday-row', 4);
      expect((await attrs(tid(ap, 'holiday-row'), 'data-date')).sort()).toEqual(HOLIDAYS);
    });

    const sc = await asCitizen(browser, ID.somchai);
    await test.step('2 NEW_PAID ก่อนแก้ → …000031 dueAt 4 ธ.ค.', async () => {
      await setClock(T0);
      const r = await newPaid(sc.api, 'SV-01', { qty: 1 });
      expect(r.amount).toBe(20);
      expect(r.caseNo).toBe(cn(31));
      expect((await getCase(sc.api, cn(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
    });

    await test.step('3 admin แก้ค่าธรรมเนียม SV-01 = 25 · SV-02 = 600', async () => {
      await open(ap, '/admin/services');
      await tid(ap, 'svc-fee-SV-01').fill('25');
      await act(ap, tid(ap, 'svc-save-SV-01'));
      await expect(tid(ap, 'action-success')).toBeVisible();
      await open(ap, '/admin/services');
      await tid(ap, 'svc-fee-SV-02').fill('600');
      await act(ap, tid(ap, 'svc-save-SV-02'));
      await expect(tid(ap, 'action-success')).toBeVisible();
      const s = await expectApi(await ad.api.get('/api/admin/services'), 200);
      const byId = Object.fromEntries(s.items.map((i: any) => [i.id, i]));
      expect(byId['SV-01'].fee).toBe(25);
      expect(byId['SV-02'].fee).toBe(600);
    });

    await test.step('4 ร่างใหม่ใช้ค่าใหม่ · คำขอเดิมยัง ฿20', async () => {
      const p = sc.page;
      await open(p, '/citizen/new/SV-01');
      await tid(p, 'qty-input').fill('5');
      await expect(tid(p, 'fee-total')).toHaveText('฿125');
      await tid(p, 'qty-input').fill('1');
      await expect(tid(p, 'fee-total')).toHaveText('฿25');
      await open(p, '/citizen/new/SV-02');
      await expect(tid(p, 'fee-total')).toHaveText('฿600');
      await open(p, `/citizen/cases/${cn(30)}`);
      await expect(tid(p, 'case-fee')).toHaveText('฿20');
    });

    await test.step('5 PP-0001 ยอดล็อก ฿500', async () => {
      const p = sc.page;
      await open(p, '/citizen/new/SV-02?draft=DR-0002');
      await expect(tid(p, 'payment-amount')).toHaveText('฿500');
      await expectApi(await sc.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 600 } }), 422, 'AMOUNT_MISMATCH');
      const ok = await expectApi(await sc.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } }), 200);
      expect(ok.status).toBe('PAID');
      expect(ok.caseNo).toBe(cn(32));
    });

    await test.step('6 เพิ่มวันหยุด 2026-12-02 · คำขอเดิมไม่คำนวณใหม่', async () => {
      await open(ap, '/admin/holidays');
      await tid(ap, 'holiday-date-input').fill('2026-12-02');
      await tid(ap, 'holiday-name-input').fill('วันหยุดทดสอบ');
      await act(ap, tid(ap, 'holiday-add-btn'));
      await expectCount(ap, 'holiday-row', 5);
      expect((await getCase(sc.api, cn(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
    });

    await test.step('7 NEW_PAID หลังเพิ่มวันหยุด → …000033 dueAt 8 ธ.ค.', async () => {
      await setClock(T0);
      const r = await newPaid(sc.api, 'SV-01', { qty: 1 });
      expect(r.amount).toBe(25);
      expect(r.caseNo).toBe(cn(33));
      expect((await getCase(sc.api, cn(33))).dueAt).toBe('2026-12-08T16:30:00+07:00');
    });

    let ex!: Actor;
    await test.step('8 เปลี่ยน exec1 เป็น auditor', async () => {
      await expectApi(await ad.api.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } }), 200);
      ex = await asStaff(browser, 'exec1');
      await open(ex.page, '/');
      expect(new URL(ex.page.url()).pathname).toBe('/audit');
      expect(await open(ex.page, '/dashboard')).toBe(403);
      await expect(tid(ex.page, 'forbidden-msg')).toHaveText(MSG.FORBIDDEN_PAGE);
    });

    const ADMIN_DETAILS = ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor'];
    await test.step('9 exec1 (auditor) เห็น ADMIN_CHANGE 4 แถว', async () => {
      await open(ex.page, '/audit');
      await auditFilterUI(ex.page, { event: 'ADMIN_CHANGE' });
      await expect(tid(ex.page, 'audit-count')).toHaveText('4');
      for (const a of await attrs(tid(ex.page, 'audit-row'), 'data-actor')) expect(a).toBe('admin1');
      for (const r of await tid(ex.page, 'audit-role').allTextContents()) expect(r.trim()).toBe('admin');
      const details = (await tid(ex.page, 'audit-detail').allTextContents()).join('\n');
      for (const d of ADMIN_DETAILS) expect(details).toContain(d);
    });

    await test.step('10 admin POST /api/drafts → 403', async () => {
      await expectApi(await ad.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }), 403);
    });

    await test.step('11 ลบวันหยุด 2026-12-02', async () => {
      await open(ap, '/admin/holidays');
      const row = ap.locator('[data-testid="holiday-row"][data-date="2026-12-02"]');
      await act(ap, tid(row, 'holiday-delete-btn'));
      await expectCount(ap, 'holiday-row', 4);
      const a = await auditApi(ex.api, { event: 'ADMIN_CHANGE' });
      expect(a.count).toBe(5);
      expect(a.items.map((i: any) => i.detail).join('\n')).toContain('holiday delete 2026-12-02');
    });
  });

  test('TC-RBAC-05 · สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ browser }) => {
    test.setTimeout(240_000);
    await reset();
    const u = {
      reg1: await asStaff(browser, 'off.reg1'),
      reg2: await asStaff(browser, 'off.reg2'),
      works: await asStaff(browser, 'off.works1'),
      head: await asStaff(browser, 'head1'),
      exec: await asStaff(browser, 'exec1'),
      audit: await asStaff(browser, 'audit1'),
      admin: await asStaff(browser, 'admin1'),
      somying: await asCitizen(browser, ID.somying),
      somchai: await asCitizen(browser, ID.somchai),
      anon: await asAnon(browser),
    };
    const SV3 = ['deed.pdf', 'id-card.pdf', 'plan.pdf'];
    // fileId จริงของแต่ละคำขอ (head เห็นทุกแผนก) ใช้ทดสอบฝั่งที่ต้องถูกปฏิเสธ
    const ids: Record<string, string[]> = {};
    for (const n of [25, 10, 12, 11]) {
      const j = await expectApi(await u.head.api.get(`/api/cases/${cn(n)}/files`), 200);
      ids[cn(n)] = j.items.map((i: any) => String(i.fileId));
      expect(ids[cn(n)].length).toBeGreaterThan(0);
    }

    async function check(a: Actor, label: string, caseNo: string, want: number, names?: string[]) {
      await test.step(`${label} ${caseNo} → ${want}`, async () => {
        const r = await a.api.get(`/api/cases/${caseNo}/files`);
        expect(r.status(), `${label} /api/cases/${caseNo}/files`).toBe(want);
        let fileIds = ids[caseNo];
        if (want === 200) {
          const j = await r.json();
          expect(j.items.map((i: any) => i.name).sort()).toEqual(names);
          fileIds = j.items.map((i: any) => String(i.fileId));
        }
        for (const fid of fileIds) {
          const f = await a.api.get(`/api/files/${fid}`);
          expect(f.status(), `${label} /api/files/${fid}`).toBe(want);
          if (want === 200) {
            expect(f.headers()['content-type']).toContain('application/pdf');
            expect((await f.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');
          }
        }
      });
    }

    await check(u.reg1, 'off.reg1', cn(25), 200, ['id-card.pdf']);
    await check(u.works, 'off.works1', cn(25), 403);
    await check(u.reg2, 'off.reg2', cn(12), 200, SV3);
    await check(u.works, 'off.works1', cn(12), 403);
    await check(u.works, 'off.works1', cn(10), 200, SV3);
    await check(u.reg1, 'off.reg1', cn(10), 200, SV3);
    await check(u.works, 'off.works1', cn(11), 200, SV3);
    await check(u.head, 'head1', cn(25), 200, ['id-card.pdf']);
    await check(u.head, 'head1', cn(10), 200, SV3);
    await check(u.head, 'head1', cn(12), 200, SV3);
    await check(u.somying, 'สมหญิง', cn(25), 200, ['id-card.pdf']);
    await check(u.somchai, 'สมชาย', cn(25), 404);
    await check(u.exec, 'exec1', cn(25), 403);
    await check(u.audit, 'audit1', cn(25), 403);
    await check(u.admin, 'admin1', cn(25), 403);
    await check(u.anon, 'ไม่ล็อกอิน', cn(25), 401);

    await test.step('fileId ที่ไม่มี → 404', async () => {
      expect((await u.reg1.api.get('/api/files/999999')).status()).toBe(404);
    });

    await test.step('UI doc-item', async () => {
      const p = u.reg1.page;
      await open(p, `/officer/cases/${cn(25)}`);
      await expectCount(p, 'doc-item', 1);
      const item = tid(p, 'doc-item');
      await expect(item).toHaveAttribute('data-name', 'id-card.pdf');
      const f = await grab(p, tid(item, 'doc-download-link'));
      expect(f.body.length).toBeGreaterThan(0);
      await open(u.reg2.page, `/officer/cases/${cn(12)}`);
      await expectCount(u.reg2.page, 'doc-item', 3);
      await open(u.somying.page, `/citizen/cases/${cn(25)}`);
      await expectCount(u.somying.page, 'doc-item', 1);
    });
  });

  test('TC-RBAC-06 · ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ browser }) => {
    await reset();
    const ad = await asStaff(browser, 'admin1');
    const p = ad.page;

    async function svc01(): Promise<{ fee: number; sla: number }> {
      const s = await expectApi(await ad.api.get('/api/admin/services'), 200);
      const it = s.items.find((i: any) => i.id === 'SV-01');
      return { fee: it.fee, sla: it.sla };
    }
    /** แก้บนจอ (โหลดหน้าใหม่ก่อน เพื่อให้ช่องอื่นเป็นค่าปัจจุบัน) */
    async function ui(field: 'fee' | 'sla', value: string) {
      await open(p, '/admin/services');
      await tid(p, `svc-${field}-SV-01`).fill(value);
      await act(p, tid(p, 'svc-save-SV-01'));
    }
    async function api(body: { fee?: number; sla?: number }) {
      const cur = await svc01();
      return ad.api.put('/api/admin/services/SV-01', { data: { fee: cur.fee, sla: cur.sla, ...body } });
    }

    await test.step('fee = −1 → 400 INVALID_FEE', async () => {
      await expectApi(await api({ fee: -1 }), 400, 'INVALID_FEE', MSG.INVALID_FEE);
      await ui('fee', '-1');
      await expect(tid(p, 'action-error')).toHaveText(MSG.INVALID_FEE);
      expect((await svc01()).fee).toBe(20);
    });
    await test.step('fee = 0 → 200 (บนจอ)', async () => {
      await ui('fee', '0');
      await expect(tid(p, 'action-success')).toBeVisible();
      expect((await svc01()).fee).toBe(0);
    });
    await test.step('fee = 100000 → 200 (API)', async () => {
      await expectApi(await api({ fee: 100000 }), 200);
      expect((await svc01()).fee).toBe(100000);
    });
    await test.step('fee = 100001 → 400 INVALID_FEE', async () => {
      await expectApi(await api({ fee: 100001 }), 400, 'INVALID_FEE', MSG.INVALID_FEE);
      await ui('fee', '100001');
      await expect(tid(p, 'action-error')).toHaveText(MSG.INVALID_FEE);
      expect((await svc01()).fee).toBe(100000);
    });
    await test.step('sla = 0 → 400 INVALID_SLA', async () => {
      await expectApi(await api({ sla: 0 }), 400, 'INVALID_SLA', MSG.INVALID_SLA);
      await ui('sla', '0');
      await expect(tid(p, 'action-error')).toHaveText(MSG.INVALID_SLA);
      expect((await svc01()).sla).toBe(3);
    });
    await test.step('sla = 1 → 200 (บนจอ)', async () => {
      await ui('sla', '1');
      await expect(tid(p, 'action-success')).toBeVisible();
      expect((await svc01()).sla).toBe(1);
    });
    await test.step('sla = 60 → 200 (API)', async () => {
      await expectApi(await api({ sla: 60 }), 200);
      expect((await svc01()).sla).toBe(60);
    });
    await test.step('sla = 61 → 400 INVALID_SLA', async () => {
      await expectApi(await api({ sla: 61 }), 400, 'INVALID_SLA', MSG.INVALID_SLA);
      await ui('sla', '61');
      await expect(tid(p, 'action-error')).toHaveText(MSG.INVALID_SLA);
      expect((await svc01()).sla).toBe(60);
    });

    await test.step('วันหยุดซ้ำ → 409 · วันเสาร์ → 201', async () => {
      await expectApi(
        await ad.api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }),
        409,
        'DUPLICATE_HOLIDAY',
        MSG.DUPLICATE_HOLIDAY,
      );
      await open(p, '/admin/holidays');
      await tid(p, 'holiday-date-input').fill('2026-12-07');
      await tid(p, 'holiday-name-input').fill('ซ้ำ');
      await act(p, tid(p, 'holiday-add-btn'));
      await expect(tid(p, 'action-error')).toHaveText(MSG.DUPLICATE_HOLIDAY);
      await expectCount(p, 'holiday-row', 4);
      await expectApi(await ad.api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } }), 201);
    });

    await test.step('เปลี่ยนบทบาทตัวเอง → 409', async () => {
      await expectApi(
        await ad.api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }),
        409,
        'SELF_ROLE_CHANGE',
        MSG.SELF_ROLE_CHANGE,
      );
      const me = await expectApi(await ad.api.get('/api/me'), 200);
      expect(me.role).toBe('admin');
    });

    await test.step('Audit ADMIN_CHANGE = 5 (ที่ถูกปฏิเสธไม่บันทึก)', async () => {
      const au = await asStaff(browser, 'audit1');
      const a = await auditApi(au.api, { event: 'ADMIN_CHANGE' });
      expect(a.count).toBe(5);
      const details = a.items.map((i: any) => i.detail).join('\n');
      for (const d of ['SV-01 fee 20 → 0', 'SV-01 fee 0 → 100000', 'SV-01 sla 3 → 1', 'SV-01 sla 1 → 60', 'holiday add 2026-12-05']) {
        expect.soft(details).toContain(d);
      }
      await open(au.page, '/audit');
      await auditFilterUI(au.page, { event: 'ADMIN_CHANGE' });
      await expect(tid(au.page, 'audit-count')).toHaveText('5');
    });
  });
});

// ═════════════════════════════════ §16 NFR ═════════════════════════════════

test.describe('§16 NFR', () => {
  const VIEWPORTS = [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ];

  test('TC-NFR-01 · Responsive 375 / 768 / 1280', async ({ browser }) => {
    test.setTimeout(300_000);
    await reset();
    const anon = await asAnon(browser);
    const sc = await asCitizen(browser, ID.somchai);
    const reg1 = await asStaff(browser, 'off.reg1');
    const head = await asStaff(browser, 'head1');
    const ex = await asStaff(browser, 'exec1');
    const au = await asStaff(browser, 'audit1');
    const ad = await asStaff(browser, 'admin1');
    const PAGES: [Actor, string][] = [
      [anon, '/login'],
      [sc, '/citizen'],
      [sc, '/citizen/new/SV-03'],
      [sc, `/citizen/cases/${cn(13)}`],
      [reg1, '/officer/queue'],
      [reg1, `/officer/cases/${cn(20)}`],
      [head, '/head/approvals'],
      [ex, '/dashboard'],
      [au, '/audit'],
      [ad, '/admin/services'],
      [anon, '/verify/K7M2Q9XA'],
    ];
    let checks = 0;
    for (const vp of VIEWPORTS) {
      for (const [a, path] of PAGES) {
        await a.page.setViewportSize(vp);
        const st = await open(a.page, path);
        expect.soft(st, `${path} @${vp.width} HTTP`).toBe(200);
        const m = await a.page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
        }));
        expect.soft(m.sw, `${path} @${vp.width}: scrollWidth ${m.sw} ≤ innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
        checks++;
      }
    }
    expect(checks).toBe(33);

    await test.step('งานหลักที่ 375 px (ผ่านหน้าจอ)', async () => {
      const m = await asAnon(browser, { viewport: { width: 375, height: 812 } });
      const p = m.page;
      await open(p, '/login');
      if ((await tid(p, 'login-tab-citizen').count()) > 0) await tid(p, 'login-tab-citizen').click();
      await tid(p, 'thaid-id-input').fill(ID.somchai);
      await tid(p, 'thaid-submit').click();
      await expect(tid(p, 'otp-step')).toBeVisible();
      await tid(p, 'otp-input').fill('123456');
      await tid(p, 'otp-submit').click();
      await expect(p).toHaveURL(/\/citizen$/);
      await act(p, tid(p, 'start-service-SV-01'));
      await expect(p).toHaveURL(/\/citizen\/new\/SV-01/);
      await tid(p, 'qty-input').fill('1');
      await expect(tid(p, 'fee-total')).toHaveText('฿20');
      await act(p, tid(p, 'to-upload-btn'));
      // รอขั้น 2 แสดงก่อนแนบไฟล์ (เหมือน helper ของชุด A): ปุ่ม 'ถัดไป' สร้างร่างแบบ async ถ้าแนบก่อนร่างพร้อม ไฟล์จะไม่ถูกส่ง
      await expect(tid(p, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
      await tid(p, 'upload-input-id-card').setInputFiles(pdfFile('id-card.pdf'));
      await expect(p.locator('[data-testid="file-item"][data-name="id-card.pdf"]')).toHaveCount(1);
      await expect(tid(p, 'to-payment-btn')).toBeEnabled();
      await act(p, tid(p, 'to-payment-btn'));
      const btn = tid(p, 'create-qr-btn');
      await expect(btn).toBeVisible();
      await btn.scrollIntoViewIfNeeded();
      const box = (await btn.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      const sw = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(sw).toBe(true);
    });
  });

  test('TC-NFR-02 · WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ browser }) => {
    test.setTimeout(300_000);
    await reset();
    const anon = await asAnon(browser);
    const mana = await asCitizen(browser, ID.mana, { expectRegistered: false });
    const sc = await asCitizen(browser, ID.somchai);
    const reg1 = await asStaff(browser, 'off.reg1');
    const head = await asStaff(browser, 'head1');
    const ex = await asStaff(browser, 'exec1');
    const au = await asStaff(browser, 'audit1');
    const ad = await asStaff(browser, 'admin1');
    const PAGES: [Actor, string][] = [
      [anon, '/login'],
      [mana, '/register'],
      [sc, '/citizen'],
      [sc, '/citizen/new/SV-01'],
      [sc, `/citizen/cases/${cn(17)}`],
      [reg1, '/officer/queue'],
      [reg1, `/officer/cases/${cn(20)}`],
      [head, '/head/approvals'],
      [ex, '/dashboard'],
      [au, '/audit'],
      [ad, '/admin/services'],
      [reg1, '/notifications'],
      [anon, '/verify/K7M2Q9XA'],
    ];

    /** ส่วน D: ข้อความสถานะ/ระดับไม่ว่างและตรงรหัส */
    async function statusTexts(p: Page, label: string) {
      const found = await p.evaluate(() => {
        const out: { id: string; text: string; code: string }[] = [];
        const pick = (id: string, own: string, rowAttr: string) =>
          document.querySelectorAll(`[data-testid="${id}"]`).forEach((el) => {
            const e = el as HTMLElement;
            const row = e.closest(`[${rowAttr}]`) as HTMLElement | null;
            const code = e.getAttribute(own) ?? row?.getAttribute(rowAttr) ?? '';
            out.push({ id, text: (e.textContent ?? '').trim(), code });
          });
        pick('case-status', 'data-status', 'data-status');
        pick('row-status', 'data-status', 'data-status');
        pick('sla-level', 'data-level', 'data-level');
        pick('row-sla-level', 'data-level', 'data-sla-level');
        return out;
      });
      for (const f of found) {
        const map = f.id.includes('status') ? STATUS_TH : LEVEL_TH;
        expect.soft(f.text, `${label} ${f.id} ไม่ว่าง`).not.toBe('');
        expect.soft(f.text, `${label} ${f.id} (${f.code})`).toBe(map[f.code]);
      }
      return found.length;
    }

    let statusCount = 0;
    for (const [a, path] of PAGES) {
      await test.step(`axe + label + สถานะ ${path}`, async () => {
        const p = a.page;
        const st = await open(p, path);
        expect.soft(st, `${path} HTTP`).toBe(200);
        // ส่วน A
        const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect.soft(
          bad.map((v) => `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`),
          `${path} axe serious/critical`,
        ).toEqual([]);
        const minor = r.violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical');
        if (minor.length)
          test.info().annotations.push({ type: 'known-issue', description: `${path}: ${minor.map((v) => `${v.id}(${v.impact})`).join(', ')}` });
        // ส่วน C
        const unlabeled = await p.evaluate(() => {
          const out: string[] = [];
          document.querySelectorAll('input, select, textarea').forEach((el) => {
            const e = el as HTMLInputElement;
            if (e.type === 'hidden') return;
            const st = getComputedStyle(e);
            const rect = e.getBoundingClientRect();
            const visible = st.display !== 'none' && st.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            if (!visible) return;
            const aria = (e.getAttribute('aria-label') ?? '').trim();
            const lb = (e.getAttribute('aria-labelledby') ?? '')
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
              .join('');
            const lab = Array.from(e.labels ?? []).map((l) => (l.textContent ?? '').trim()).join('');
            if (!aria && !lb && !lab) out.push(e.getAttribute('data-testid') || e.name || e.id || e.outerHTML.slice(0, 80));
          });
          return out;
        });
        expect.soft(unlabeled, `${path} ช่องที่ไม่มีชื่อ`).toEqual([]);
        // ส่วน D
        statusCount += await statusTexts(p, path);
        await p.emulateMedia({ forcedColors: 'active' });
        await statusTexts(p, `${path} [forced-colors]`);
        await p.emulateMedia({ forcedColors: 'none' });
      });
    }
    expect(statusCount, 'มีองค์ประกอบสถานะให้ตรวจ').toBeGreaterThan(0);

    await test.step('ส่วน B คีย์บอร์ดอย่างเดียว', async () => {
      const k = await asAnon(browser);
      const p = k.page;
      const focusIssues: string[] = [];
      /** กด Tab จนโฟกัสถึง testid ที่ต้องการ · ตรวจว่าทุกจุดที่โฟกัสมี outline/ring */
      async function tabTo(id: string, max = 60) {
        for (let i = 0; i < max; i++) {
          await p.keyboard.press('Tab');
          const info = await p.evaluate(() => {
            const e = document.activeElement as HTMLElement | null;
            if (!e || e === document.body) return { id: '', ring: true, desc: 'body' };
            const ringOf = (x: Element | null) => {
              if (!x) return false;
              const s = getComputedStyle(x);
              const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
              return outline || (s.boxShadow !== 'none' && s.boxShadow !== '');
            };
            const labels = (e as HTMLInputElement).labels ? Array.from((e as HTMLInputElement).labels!) : [];
            const ring = ringOf(e) || labels.some(ringOf) || ringOf(e.parentElement);
            return { id: e.getAttribute('data-testid') ?? '', ring, desc: e.getAttribute('data-testid') || e.tagName };
          });
          if (!info.ring) focusIssues.push(info.desc);
          if (info.id === id) return;
        }
        throw new Error(`Tab ไม่ถึง ${id}`);
      }
      await open(p, '/login');
      await tabTo('thaid-id-input');
      await p.keyboard.type(ID.somchai);
      await p.keyboard.press('Enter');
      await expect(tid(p, 'otp-input')).toBeVisible();
      const otpFocused = await p.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      if (otpFocused !== 'otp-input') await tabTo('otp-input');
      await p.keyboard.type('123456');
      await p.keyboard.press('Enter');
      await expect(p).toHaveURL(/\/citizen$/);
      await tabTo('start-service-SV-01');
      await p.keyboard.press('Enter');
      await expect(p).toHaveURL(/\/citizen\/new\/SV-01/);
      await tabTo('qty-input');
      await p.keyboard.press('Control+A');
      await p.keyboard.type('1');
      await tabTo('to-upload-btn');
      await p.keyboard.press('Enter');
      await tabTo('upload-input-id-card');
      await tid(p, 'upload-input-id-card').setInputFiles(pdfFile('id-card.pdf'));
      await expect(p.locator('[data-testid="file-item"][data-name="id-card.pdf"]')).toHaveCount(1);
      await tabTo('to-payment-btn');
      await p.keyboard.press('Enter');
      await expect(tid(p, 'create-qr-btn')).toBeVisible();
      expect(focusIssues, 'องค์ประกอบที่โฟกัสแต่ไม่มี outline/ring').toEqual([]);
    });
  });

  test('TC-NFR-03 · Health เวลาโหลด และผลซ้ำได้', async ({ browser }) => {
    test.setTimeout(240_000);

    await test.step('health', async () => {
      const r = await rawApi();
      const res = await r.get('/api/health');
      expect(res.status()).toBe(200);
      expect(JSON.parse(await res.text())).toStrictEqual({ status: 'ok' });
    });

    await test.step('เวลาโหลด ≤ 3,000 ms (รอบที่ 2)', async () => {
      await reset();
      const list: [Actor, string][] = [
        [await asAnon(browser), '/login'],
        [await asCitizen(browser, ID.somchai), '/citizen'],
        [await asStaff(browser, 'off.reg1'), '/officer/queue'],
        [await asStaff(browser, 'exec1'), '/dashboard'],
        [await asStaff(browser, 'audit1'), '/audit'],
      ];
      for (const [a, path] of list) {
        await a.page.goto(path, { waitUntil: 'load' }); // อุ่นเครื่อง
        const t = Date.now();
        const res = await a.page.goto(path, { waitUntil: 'load' });
        const ms = Date.now() - t;
        expect(res?.status(), `${path} HTTP`).toBe(200);
        expect.soft(ms, `${path} โหลด ${ms} ms`).toBeLessThanOrEqual(3000);
        test.info().annotations.push({ type: 'load-ms', description: `${path} ${ms} ms` });
      }
    });

    async function snapshot() {
      const hook = await rawApi();
      const clock = await expectApi(await hook.get('/api/test/clock'), 200);
      const reg1 = await asStaff(browser, 'off.reg1');
      const q = await expectApi(await reg1.api.get('/api/officer/queue?filter=all'), 200);
      const ex = await asStaff(browser, 'exec1');
      const d = await dashApi(ex.api, '2026-12', 'ALL');
      return {
        clock: clock.now,
        queue: q.items.map((i: any) => ({ caseNo: i.caseNo, dueAt: i.dueAt, status: i.status, owner: i.owner })),
        dash: d,
      };
    }

    await test.step('ผลซ้ำได้ S1 = S2', async () => {
      await reset();
      const s1 = await snapshot();
      expect(s1.clock).toBe(T0);
      await setClock('2026-12-10T12:00:00+07:00');
      const reg1 = await asStaff(browser, 'off.reg1');
      await expectApi(await reg1.api.post(`/api/officer/cases/${cn(28)}/claim`), 200);
      const sc = await asCitizen(browser, ID.somchai);
      await newPaid(sc.api, 'SV-01', { qty: 1 });
      await reset();
      const s2 = await snapshot();
      expect(s2).toEqual(s1);
      expect(s2.clock).toBe(T0);
    });

    await test.step('นาฬิกาไม่มี offset → 400 INVALID_TIME', async () => {
      const r = await rawApi();
      await expectApi(await r.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } }), 400, 'INVALID_TIME');
    });

    await test.step('ปิด hook เมื่อไม่ตั้ง TEST_MODE (ถ้ามีเว็บโหมดที่สอง)', async () => {
      const url = process.env.BASE_URL_NO_TEST_MODE;
      if (!url) {
        test.info().annotations.push({ type: 'skip-part', description: 'ไม่ได้ตั้ง BASE_URL_NO_TEST_MODE → ข้ามการตรวจ /api/test/* = 404' });
        return;
      }
      const r = await pwRequest.newContext({ baseURL: url });
      try {
        expect((await r.post('/api/test/reset')).status()).toBe(404);
      } finally {
        await r.dispose();
      }
    });
  });

  test('TC-NFR-04 · เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async ({ browser }) => {
    await reset();

    await test.step('มานะลงทะเบียน (เบอร์ 0845678901)', async () => {
      const mana = await asCitizen(browser, ID.mana, { expectRegistered: false });
      await expectApi(
        await mana.api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: true } }),
        201,
      );
    });

    await test.step('ตัวควบคุมบวก: สมชายยังได้ idNo เต็ม', async () => {
      const sc = await asCitizen(browser, ID.somchai);
      expect((await getCase(sc.api, cn(5))).idNo).toBe('1101700123456');
    });

    await test.step('ค้นค่าตรงตัวในไฟล์ฐานข้อมูล', async () => {
      const db = dbCandidates().find((f) => fs.existsSync(f));
      test.skip(!db, `ไม่พบไฟล์ฐานข้อมูลบนเครื่องที่รัน test (ลอง: ${dbCandidates().join(', ')}) · ตั้ง HOST_DB_PATH`);
      const files = scanTargets(db!);
      test.info().annotations.push({ type: 'inspected', description: files.join(', ') });
      const NEEDLES = [...PII_IDS, ...PII_MOBILES, ...PII_IDS_DASHED];
      const found: string[] = [];
      for (const f of files) for (const n of NEEDLES) {
        const c = countInFile(f, n);
        if (c > 0) found.push(`${n} ×${c} ใน ${f}`);
      }
      expect(found, 'ค่าที่ต้องไม่พบในที่เก็บ').toEqual([]);
      test.info().annotations.push({
        type: 'encryption',
        description: 'ผู้ทดสอบบันทึกวิธีเข้ารหัสที่เว็บใช้ (เช่น AES-256-GCM) ในรายงาน · HTTPS = Q-08',
      });
    });
  });
});
