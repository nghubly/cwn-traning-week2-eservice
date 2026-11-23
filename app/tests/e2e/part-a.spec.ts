/**
 * part-a.spec.ts · ชุด A ของ TEST-PLAN: AUTH(4) FEE(1) SUBMIT(3) UPLOAD(2) PAY(4) QUEUE(3) SLA(3) NOTI(2) = 22 TC
 * ค่าคาดหวังทุกตัวคัดจากการ์ด TC (TEST-PLAN §2–§9) · CONTRACT · TEST-DATA ตรงตัว
 * ทุก TC: h.reset() ก่อน แล้วสร้าง context ใหม่ + ล็อกอินใหม่ (reset ล้าง session ทุกคน · CONTRACT 0.9)
 * รัน: BASE_URL=http://localhost:3000 npx playwright test e2e/part-a.spec.ts   (เว็บต้องเปิด TEST_MODE=1)
 */
import {
  test,
  expect,
  CIT,
  STAFF_NAME,
  OTP_OK,
  PASSWORD,
  cn,
  rc,
  tf,
  body,
  expectErr,
  expectOk,
  thaidStart,
  thaidVerify,
  loginCitizen,
  createDraft,
  uploadFile,
  uploadRequired,
  createQr,
  newPending,
  payNew,
  getPayment,
  myCases,
  getCase,
  claim,
  returnCase,
  resubmit,
  notiPairs,
  pairs,
  expectPath,
  byAttr,
  attrs,
  uiLoginCitizen,
  uiLoginStaff,
  queueCaseNos,
  openQueue,
  expectQueue,
  expectWorkload,
  uiNotiPairs,
  wizardToUpload,
  uiUpload,
  uiRemoveFile,
  type Harness,
  type ServiceId,
} from './helpers-a';
import type { Page } from '@playwright/test';

const tid = (page: Page, id: string) => page.getByTestId(id);

// ═════════════════════════════════════════ §2 AUTH ═════════════════════════════════════════

test.describe('AUTH', () => {
  test('TC-AUTH-01 · เลขบัตร 13 หลัก + checksum', async ({ h }) => {
    await h.reset();
    const { page } = await h.anonPage();
    const api = await h.anonApi();

    const openCitizenTab = async () => {
      await page.goto('/login');
      await tid(page, 'login-tab-citizen').click();
      await expect(tid(page, 'thaid-submit')).toHaveText('เข้าสู่ระบบด้วย ThaiD (จำลอง)');
    };

    const invalid = ['110170012345', '11017001234567', '1101700123457', '11017001234ab'];
    for (const v of invalid) {
      await test.step(`ปฏิเสธ ${v}`, async () => {
        await openCitizenTab();
        await tid(page, 'thaid-id-input').fill(v);
        await expect(tid(page, 'thaid-id-input')).toHaveValue(v); // ไม่จำกัด maxlength (14 ตัวต้องพิมพ์ครบ)
        await tid(page, 'thaid-submit').click();
        await expect(tid(page, 'thaid-error')).toHaveText('เลขบัตรประชาชนไม่ถูกต้อง');
        await expect(tid(page, 'otp-step')).toBeHidden();
        await expectErr(await thaidStart(api, v), 400, 'INVALID_ID');
      });
    }

    const valid = [CIT.somchai, CIT.somying, CIT.piti, CIT.mana];
    for (const v of valid) {
      await test.step(`รับ ${v}`, async () => {
        await openCitizenTab();
        await tid(page, 'thaid-id-input').fill(v);
        await tid(page, 'thaid-submit').click();
        await expect(tid(page, 'otp-step')).toBeVisible();
        await expect(tid(page, 'thaid-error')).toBeHidden();
        const b = await expectOk(await thaidStart(api, v));
        expect(b).toMatchObject({ status: 'OTP_SENT' });
      });
    }
  });

  test('TC-AUTH-02 · OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ h }) => {
    // ── ส่วน UI (testid ตามการ์ด) ──
    await h.reset();
    const { page } = await h.anonPage();

    /** ลอง OTP บนหน้า: ใช้ช่อง OTP เดิมถ้ายังแสดง มิฉะนั้นเริ่มใหม่จาก /login */
    const uiOtp = async (otp: string) => {
      if (!(await tid(page, 'otp-input').isVisible())) {
        await page.goto('/login');
        await tid(page, 'login-tab-citizen').click();
        await tid(page, 'thaid-id-input').fill(CIT.piti);
        await tid(page, 'thaid-submit').click();
        await expect(tid(page, 'otp-step').or(tid(page, 'lock-message')).first()).toBeVisible();
        if (!(await tid(page, 'otp-input').isVisible())) return;
      }
      await tid(page, 'otp-input').fill(otp);
      await tid(page, 'otp-submit').click();
    };

    await test.step('UI 1–3: ผิด 3 ครั้ง → ล็อก', async () => {
      await page.goto('/login');
      await tid(page, 'login-tab-citizen').click();
      await tid(page, 'thaid-id-input').fill(CIT.piti);
      await tid(page, 'thaid-submit').click();
      await expect(tid(page, 'otp-step')).toBeVisible();
      await expect(tid(page, 'otp-submit')).toHaveText('ยืนยัน OTP');

      await uiOtp('000000');
      await expect(tid(page, 'otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
      await expect(tid(page, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');

      await uiOtp('000000');
      await expect(tid(page, 'otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');

      await uiOtp('000000');
      await expect(tid(page, 'lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
      await expect(tid(page, 'lock-until')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
    });

    await test.step('UI 4: OTP ถูกทันที → ยังล็อก', async () => {
      await uiOtp(OTP_OK);
      await expect(tid(page, 'lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
    });

    await test.step('UI 5: สมชายล็อกอินได้ระหว่างที่ปิติถูกล็อก', async () => {
      const other = await h.anonPage();
      await uiLoginCitizen(other.page, CIT.somchai);
      await expectPath(other.page, '/citizen');
    });

    await test.step('UI 6: 09:14:59 → ยังล็อก', async () => {
      await h.clock('2026-12-01T09:14:59+07:00');
      await uiOtp(OTP_OK);
      await expect(tid(page, 'lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
    });

    await test.step('UI 7–8: 09:15:00 ปลดล็อก ตัวนับเริ่มใหม่ แล้วล็อกอินสำเร็จ', async () => {
      await h.clock('2026-12-01T09:15:00+07:00');
      await page.goto('/login');
      await tid(page, 'login-tab-citizen').click();
      await tid(page, 'thaid-id-input').fill(CIT.piti);
      await tid(page, 'thaid-submit').click();
      await expect(tid(page, 'otp-step')).toBeVisible();
      await tid(page, 'otp-input').fill('000000');
      await tid(page, 'otp-submit').click();
      await expect(tid(page, 'otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
      await expect(tid(page, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
      await uiOtp(OTP_OK);
      await expectPath(page, '/citizen');
    });

    // ── ส่วน API (HTTP + code ตามการ์ด) ──
    await h.reset();
    const api = await h.anonApi();
    await test.step('API 1–4', async () => {
      await expectOk(await thaidStart(api, CIT.piti));
      let b = await expectErr(await thaidVerify(api, CIT.piti, '000000'), 401, 'OTP_INVALID');
      expect(b.attemptsLeft).toBe(2);
      b = await expectErr(await thaidVerify(api, CIT.piti, '000000'), 401, 'OTP_INVALID');
      expect(b.attemptsLeft).toBe(1);
      b = await expectErr(await thaidVerify(api, CIT.piti, '000000'), 423, 'LOCKED');
      expect(b.lockedUntil).toBe('2026-12-01T09:15:00+07:00');
      await expectErr(await thaidVerify(api, CIT.piti, OTP_OK), 423, 'LOCKED');
    });
    await test.step('API 5: สมชายล็อกอินปกติ', async () => {
      const other = await h.anonApi();
      const b = await loginCitizen(other, CIT.somchai);
      expect(b).toMatchObject({ registered: true });
    });
    await test.step('API 6: 09:14:59 ยัง 423', async () => {
      await h.clock('2026-12-01T09:14:59+07:00');
      await expectErr(await thaidVerify(api, CIT.piti, OTP_OK), 423, 'LOCKED');
    });
    await test.step('API 7–8: 09:15:00 ปลดล็อก', async () => {
      await h.clock('2026-12-01T09:15:00+07:00');
      await expectOk(await thaidStart(api, CIT.piti));
      const b = await expectErr(await thaidVerify(api, CIT.piti, '000000'), 401, 'OTP_INVALID');
      expect(b.attemptsLeft).toBe(2);
      expect(await expectOk(await thaidVerify(api, CIT.piti, OTP_OK))).toMatchObject({ registered: true });
    });

    await test.step('9: RESET · ผิด 2 → ถูก → ออก → ผิด 2 ไม่ล็อก', async () => {
      await h.reset();
      const a = await h.anonApi();
      await expectOk(await thaidStart(a, CIT.piti));
      expect((await expectErr(await thaidVerify(a, CIT.piti, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
      expect((await expectErr(await thaidVerify(a, CIT.piti, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
      await expectOk(await thaidVerify(a, CIT.piti, OTP_OK));
      await expectOk(await a.post('/api/auth/logout'), 204);
      await expectOk(await thaidStart(a, CIT.piti));
      expect((await expectErr(await thaidVerify(a, CIT.piti, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
      expect((await expectErr(await thaidVerify(a, CIT.piti, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
    });
  });

  test('TC-AUTH-03 · ลงทะเบียนครั้งแรก', async ({ h }) => {
    await h.reset();
    const { page } = await h.anonPage();
    const visited: string[] = [];

    await test.step('LOGIN_C มานะผ่าน /login → /register', async () => {
      await uiLoginCitizen(page, CIT.mana);
      await expectPath(page, '/register');
    });

    await test.step('1: reg-name แก้ไม่ได้', async () => {
      const name = tid(page, 'reg-name');
      await expect(name).toHaveValue('มานะ ตั้งใจ');
      await expect(name).toHaveJSProperty('readOnly', true);
      await name.click();
      await page.keyboard.type('xyz');
      await expect(name).toHaveValue('มานะ ตั้งใจ');
    });

    const submitWith = async (mobile: string, consent: boolean) => {
      await tid(page, 'reg-mobile').fill(mobile);
      await tid(page, 'reg-consent').setChecked(consent);
      await tid(page, 'reg-submit').click();
    };

    for (const m of ['081234567', '08123456789', '1812345678', '08123abcde']) {
      await test.step(`2–4: เบอร์ ${m}`, async () => {
        await submitWith(m, true);
        await expect(tid(page, 'reg-error-mobile')).toHaveText('เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');
        await expectPath(page, '/register');
      });
    }

    await test.step('5: ไม่ติ๊กยินยอม', async () => {
      await submitWith('0845678901', false);
      await expect(tid(page, 'reg-error-consent')).toHaveText('กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)');
      await expectPath(page, '/register');
    });

    await test.step('6: ครบ → /citizen', async () => {
      await tid(page, 'reg-email').fill('');
      await submitWith('0845678901', true);
      await expectPath(page, '/citizen');
      await expect(tid(page, 'citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
    });

    await test.step('7: ออก → ล็อกอินใหม่ เข้า /citizen ตรงๆ', async () => {
      await tid(page, 'logout-btn').click();
      await expectPath(page, '/login');
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) visited.push(f.url());
      });
      await uiLoginCitizen(page, CIT.mana);
      await expectPath(page, '/citizen');
      expect(visited.filter((u) => new URL(u).pathname === '/register')).toEqual([]);
    });

    await test.step('8: RESET · API register ก่อนลงทะเบียน', async () => {
      await h.reset();
      const api = await h.anonApi();
      await expectOk(await thaidStart(api, CIT.mana));
      const v = await expectOk(await thaidVerify(api, CIT.mana, OTP_OK));
      expect(v).toMatchObject({ registered: false });
      await expectErr(
        await api.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } }),
        400,
        'INVALID_MOBILE',
      );
      await expectErr(
        await api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } }),
        400,
        'CONSENT_REQUIRED',
      );
    });
  });

  test('TC-AUTH-04 · เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้น', async ({ h }) => {
    await h.reset();
    const { page } = await h.anonPage();

    const table: Array<[string, string, string, string, string | null]> = [
      ['off.reg1', '/officer/queue', 'เจ้าหน้าที่', 'officer', 'registry'],
      ['off.reg2', '/officer/queue', 'เจ้าหน้าที่', 'officer', 'registry'],
      ['off.works1', '/officer/queue', 'เจ้าหน้าที่', 'officer', 'works'],
      ['head1', '/head/approvals', 'หัวหน้าฝ่าย', 'head', null],
      ['exec1', '/dashboard', 'ผู้บริหาร', 'executive', null],
      ['audit1', '/audit', 'ผู้ตรวจสอบภายใน', 'auditor', null],
      ['admin1', '/admin/services', 'ผู้ดูแลระบบ', 'admin', null],
    ];

    await page.goto('/login');
    await tid(page, 'login-tab-staff').click();
    await expect(tid(page, 'staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');

    for (const [user, landing, roleText, role, dept] of table) {
      await test.step(`${user} → ${landing}`, async () => {
        await uiLoginStaff(page, user);
        await expectPath(page, landing);
        await expect(tid(page, 'user-name')).toHaveText(STAFF_NAME[user]);
        await expect(tid(page, 'user-role')).toHaveText(roleText);
        await expect(tid(page, 'user-role')).toHaveAttribute('data-role', role);
        if (dept) await expect(tid(page, 'user-role')).toHaveAttribute('data-dept', dept);
        await tid(page, 'logout-btn').click();
        await expectPath(page, '/login');
      });
    }

    const api = await h.anonApi();
    const bad: Array<[string, string]> = [
      ['off.reg1', 'wrong'],
      ['nobody', PASSWORD],
      [CIT.somchai, PASSWORD],
    ];
    for (const [u, p] of bad) {
      await test.step(`ปฏิเสธ ${u}/${p}`, async () => {
        await uiLoginStaff(page, u, p);
        await expect(tid(page, 'staff-error')).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        await expectErr(
          await api.post('/api/auth/staff/login', { data: { username: u, password: p } }),
          401,
          'INVALID_CREDENTIALS',
        );
      });
    }

    await test.step('ออกจากระบบแล้วเปิด /officer/queue → /login', async () => {
      await uiLoginStaff(page, 'off.reg1');
      await expectPath(page, '/officer/queue');
      await tid(page, 'logout-btn').click();
      await expectPath(page, '/login');
      await page.goto('/officer/queue');
      await expectPath(page, '/login');
    });
  });
});

// ═════════════════════════════════════════ §3 FEE ═════════════════════════════════════════

test.describe('FEE', () => {
  test('TC-FEE-01 · ค่าธรรมเนียม SV-01 / SV-02 / SV-03', async ({ h }) => {
    await h.reset();
    const { page, api } = await h.citizenPage(CIT.somchai);

    const checkInput = async (input: string, value: number, fee: string | null, err: string | null) => {
      await tid(page, input).fill(String(value));
      await tid(page, input).blur();
      if (fee) {
        await expect(tid(page, 'fee-total')).toHaveText(fee);
        await expect(tid(page, 'fee-error')).toBeHidden();
        await expect(tid(page, 'to-upload-btn')).toBeEnabled();
      } else {
        await expect(tid(page, 'fee-total')).toHaveText('–');
        await expect(tid(page, 'fee-error')).toHaveText(err as string);
        await expect(tid(page, 'to-upload-btn')).toBeDisabled();
      }
    };

    await test.step('SV-03 พื้นที่', async () => {
      await page.goto('/citizen/new/SV-03');
      const rows: Array<[number, number | null, string | null]> = [
        [0, null, 'INVALID_AREA'],
        [-1, null, 'INVALID_AREA'],
        [1, 1000, null],
        [100, 1000, null],
        [101, 1010, null],
        [102, 1020, null],
        [250, 2500, null],
        [300, 3000, null],
        [499, 4990, null],
        [500, 5000, null],
        [501, null, 'AREA_TOO_LARGE'],
      ];
      const msg: Record<string, string> = {
        INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
        AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
      };
      for (const [area, fee, code] of rows) {
        const shown = fee === null ? null : `฿${fee.toLocaleString('en-US')}`;
        await checkInput('area-input', area, shown, code ? msg[code] : null);
        const r = await api.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: area } });
        if (fee === null) await expectErr(r, 400, code as string);
        else expect((await expectOk(r, 201)).fee).toBe(fee);
      }
    });

    await test.step('SV-01 จำนวนฉบับ', async () => {
      await page.goto('/citizen/new/SV-01');
      const rows: Array<[number, number | null]> = [
        [0, null],
        [1, 20],
        [2, 40],
        [3, 60],
        [4, 80],
        [5, 100],
        [6, null],
      ];
      for (const [qty, fee] of rows) {
        await checkInput('qty-input', qty, fee === null ? null : `฿${fee}`, 'จำนวนฉบับต้อง 1–5 ฉบับ');
        const r = await api.post('/api/drafts', { data: { serviceId: 'SV-01', qty } });
        if (fee === null) await expectErr(r, 400, 'INVALID_QTY');
        else expect((await expectOk(r, 201)).fee).toBe(fee);
      }
    });

    await test.step('SV-02 คงที่ ฿500', async () => {
      await page.goto('/citizen/new/SV-02');
      await expect(tid(page, 'fee-total')).toHaveText('฿500');
      await expect(tid(page, 'qty-input')).toHaveCount(0);
      await expect(tid(page, 'area-input')).toHaveCount(0);
      expect((await createDraft(api, 'SV-02')).fee).toBe(500);
    });
  });
});

// ═════════════════════════════════════════ §4 SUBMIT ═════════════════════════════════════════

test.describe('SUBMIT', () => {
  test('TC-SUBMIT-01 · ยื่นคำขอ SV-01 ครบวงจร', async ({ h }) => {
    await h.reset();
    const { page } = await h.citizenPage(CIT.somchai);

    await test.step('1: กรอกข้อมูล', async () => {
      await page.goto('/citizen');
      await tid(page, 'start-service-SV-01').click();
      await expectPath(page, '/citizen/new/SV-01');
      await expect(tid(page, 'wizard-step')).toHaveText('1/3 กรอกข้อมูล');
      await tid(page, 'qty-input').fill('2');
      await expect(tid(page, 'fee-total')).toHaveText('฿40');
      await tid(page, 'to-upload-btn').click();
    });

    await test.step('2: แนบเอกสาร', async () => {
      await expect(tid(page, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
      await expect(tid(page, 'to-payment-btn')).toBeDisabled();
      await uiUpload(page, 'id-card', tf('id-card.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(1);
      await expect(tid(page, 'file-item')).toHaveAttribute('data-doc-key', 'id-card');
      await expect(tid(page, 'to-payment-btn')).toBeEnabled();
      await tid(page, 'to-payment-btn').click();
    });

    await test.step('3: ชำระเงิน สร้าง QR', async () => {
      await expect(tid(page, 'wizard-step')).toHaveText('3/3 ชำระเงิน');
      await expect(tid(page, 'payment-amount')).toHaveText('฿40');
      await tid(page, 'create-qr-btn').click();
      await expect(tid(page, 'qr-ref')).toHaveText('PP-0002');
      await expect(tid(page, 'qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
      await expect(tid(page, 'payment-status')).toHaveText('รอชำระ');
    });

    await test.step('4: ชำระ (test hook) และตรวจใบเสร็จ', async () => {
      const r = await expectOk(await h.pay('PP-0002', 40));
      expect(r).toMatchObject({ status: 'PAID', caseNo: cn(31), receiptNo: rc(31), duplicate: false });
      await tid(page, 'refresh-payment-btn').click();
      await expect(tid(page, 'payment-status')).toHaveText('ชำระแล้ว');
      await expect(tid(page, 'payment-status')).toHaveAttribute('data-status', 'PAID');
      await expect(tid(page, 'submitted-case-no')).toHaveText(cn(31));
      await expect(tid(page, 'receipt-no')).toHaveText(rc(31));
      await expect(tid(page, 'receipt-amount')).toHaveText('฿40');
      await expect(tid(page, 'receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
    });

    await test.step('5: หน้าคำขอ', async () => {
      await tid(page, 'go-case-btn').click();
      await expectPath(page, `/citizen/cases/${cn(31)}`);
      await expect(tid(page, 'case-status')).toHaveText('ส่งคำขอแล้ว');
      await expect(tid(page, 'case-status')).toHaveAttribute('data-status', 'SUBMITTED');
      await expect(tid(page, 'case-fee')).toHaveText('฿40');
      await expect(tid(page, 'sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
      await expect(tid(page, 'sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
      await expect(tid(page, 'sla-level')).toHaveText('ปกติ');
      await expect(tid(page, 'cancel-case-btn')).toHaveCount(1);
      await expect(tid(page, 'case-step')).toHaveCount(0);
    });

    await test.step('off.reg1 เห็นในคิวท้ายกลุ่ม 4 ธ.ค.', async () => {
      const o = await h.staffPage('off.reg1');
      await o.page.goto('/officer/queue');
      const row = byAttr(o.page, 'queue-row', 'data-case-no', cn(31));
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('row-owner')).toHaveText(/^\s*$/);
      await expect(row.getByTestId('claim-btn')).toHaveCount(1);
      const list = await queueCaseNos(o.page);
      expect(list[list.indexOf(cn(30)) + 1]).toBe(cn(31));
    });
  });

  test('TC-SUBMIT-02 · เอกสารบังคับครบก่อนชำระ', async ({ h }) => {
    await h.reset();
    const { page, api } = await h.citizenPage(CIT.somchai);

    await test.step('SV-02', async () => {
      await wizardToUpload(page, 'SV-02');
      await uiUpload(page, 'id-card', tf('id-card.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(1);
      await expect(tid(page, 'to-payment-btn')).toBeDisabled();
      await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

      await uiUpload(page, 'map', tf('map.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(2);
      await expect(tid(page, 'to-payment-btn')).toBeEnabled();
      await expect(tid(page, 'missing-docs')).toHaveCount(0);

      await byAttr(page, 'file-item', 'data-doc-key', 'map').getByTestId('file-remove-btn').click();
      await expect(tid(page, 'file-item')).toHaveCount(1);
      await expect(tid(page, 'to-payment-btn')).toBeDisabled();
      await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
    });

    await test.step('SV-03 พื้นที่ 100', async () => {
      await wizardToUpload(page, 'SV-03', { areaSqm: 100 });
      await uiUpload(page, 'id-card', tf('id-card.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(1);
      await expect(tid(page, 'to-payment-btn')).toBeDisabled();
      await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');

      await uiUpload(page, 'deed', tf('deed.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(2);
      await expect(tid(page, 'to-payment-btn')).toBeDisabled();
      await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');

      await uiUpload(page, 'plan', tf('plan-as-jpg.jpg'));
      await expect(tid(page, 'upload-error')).toHaveText('แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น');
      await expect(tid(page, 'file-item')).toHaveCount(2);
      await expect(tid(page, 'to-payment-btn')).toBeDisabled();
      await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');

      await uiUpload(page, 'plan', tf('plan.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(3);
      await expect(tid(page, 'to-payment-btn')).toBeEnabled();
      await expect(tid(page, 'missing-docs')).toHaveCount(0);
    });

    await test.step('API: ขาดแบบแปลน 409 → ครบ 201', async () => {
      const d = await createDraft(api, 'SV-03', { areaSqm: 100 });
      await expectOk(await uploadFile(api, d.draftId, 'id-card', tf('id-card.pdf')), 201);
      await expectOk(await uploadFile(api, d.draftId, 'deed', tf('deed.pdf')), 201);
      const b = await expectErr(await api.post(`/api/drafts/${d.draftId}/payment`), 409, 'MISSING_DOCS');
      expect(b.missing).toEqual(['แบบแปลน']);
      await expectOk(await uploadFile(api, d.draftId, 'plan', tf('plan.pdf')), 201);
      await expectOk(await api.post(`/api/drafts/${d.draftId}/payment`), 201);
    });
  });

  test('TC-SUBMIT-03 · ร่าง และการยกเลิก', async ({ h }) => {
    await test.step('ส่วน A ร่าง', async () => {
      await h.reset();
      const { page, api } = await h.citizenPage(CIT.somchai);
      await page.goto('/citizen');
      await expect(tid(page, 'my-case-row')).toHaveCount(10);
      await expect(tid(page, 'my-draft-row')).toHaveCount(2);
      await expect(byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0001')).toHaveAttribute('data-status', 'DRAFT');
      await expect(byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0002')).toHaveAttribute('data-status', 'PENDING_PAYMENT');
      for (const t of await tid(page, 'my-draft-row').allTextContents()) expect(t).not.toContain('EG-');

      await byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0001').getByTestId('open-draft-btn').click();
      await expect(tid(page, 'qty-input')).toHaveValue('2');
      await expect(tid(page, 'fee-total')).toHaveText('฿40');

      await page.goto('/citizen/new/SV-01');
      await tid(page, 'qty-input').fill('3');
      await tid(page, 'save-draft-btn').click();
      await expect(tid(page, 'draft-id')).toHaveText('DR-0003');
      await page.goto('/citizen');
      await expect(tid(page, 'my-case-row')).toHaveCount(10);
      expect((await myCases(api)).length).toBe(10);
      expect((await expectOk(await api.get('/api/drafts'))).items.length).toBe(3);
    });

    await test.step('ส่วน B ยกเลิก (RESET)', async () => {
      await h.reset();
      const { page } = await h.citizenPage(CIT.somchai);
      await page.goto(`/citizen/cases/${cn(30)}`);
      await expect(tid(page, 'cancel-case-btn')).toHaveCount(1);
      await tid(page, 'cancel-case-btn').click();
      await expect(tid(page, 'cancel-confirm-text')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
      await tid(page, 'confirm-cancel-btn').click();
      await expect(tid(page, 'case-status')).toHaveText('ยกเลิก');
      await expect(tid(page, 'case-status')).toHaveAttribute('data-status', 'CANCELLED');
      await expect(tid(page, 'no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
      await expect(tid(page, 'cancel-case-btn')).toHaveCount(0);

      const o = await h.staffPage('off.reg1');
      await o.page.goto('/officer/queue');
      await expect(tid(o.page, 'queue-row')).toHaveCount(16);
      await expect(byAttr(o.page, 'queue-row', 'data-case-no', cn(30))).toHaveCount(0);

      const e = await h.staffPage('exec1');
      await e.page.goto('/dashboard');
      await expect(tid(e.page, 'kpi-backlog')).toHaveText('20');
      await expect(tid(e.page, 'kpi-received')).toHaveText('3');
    });

    await test.step('ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ (RESET)', async () => {
      await h.reset();
      const o = await h.staff('off.reg1');
      await expectOk(await claim(o.api, cn(30)));
      const { page, api } = await h.citizenPage(CIT.somchai);
      await page.goto(`/citizen/cases/${cn(30)}`);
      await expect(tid(page, 'case-status')).toHaveText('กำลังตรวจสอบ');
      await expect(tid(page, 'cancel-case-btn')).toHaveCount(0);
      await expectErr(
        await api.post(`/api/cases/${cn(30)}/cancel`),
        409,
        'CANNOT_CANCEL',
        'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
      );
      await expectErr(await api.post(`/api/cases/${cn(13)}/cancel`), 409);
    });

    await test.step('ส่วน E ลบร่าง (RESET)', async () => {
      await h.reset();
      const { page, api } = await h.citizenPage(CIT.somchai);
      await expectOk(await api.delete('/api/drafts/DR-0001'), 204);
      await expectErr(await api.get('/api/drafts/DR-0001'), 404);
      await page.goto('/citizen');
      await expect(tid(page, 'my-draft-row')).toHaveCount(1);
      await expect(tid(page, 'my-draft-row')).toHaveAttribute('data-draft-id', 'DR-0002');
      await expectOk(await api.delete('/api/drafts/DR-0002'), 204);
      await expectErr(await getPayment(api, 'PP-0001'), 404);
      await expectErr(await h.pay('PP-0001', 500), 404);
    });

    await test.step('ส่วน F ยกเลิกชนกับรับเรื่อง (RESET)', async () => {
      await h.reset();
      const c = await h.citizen(CIT.somchai);
      const o = await h.staff('off.reg1');
      const [rCancel, rClaim] = await Promise.all([c.api.post(`/api/cases/${cn(30)}/cancel`), claim(o.api, cn(30))]);
      const ok = [rCancel.status(), rClaim.status()].filter((s) => s === 200).length;
      expect(ok, 'ต้องสำเร็จฝั่งเดียว').toBe(1);
      const op = await h.staffPage('off.reg1');
      const cs = await getCase(o.api, cn(30));
      if (rCancel.status() === 200) {
        await expectErr(rClaim, 409, 'INVALID_STATE');
        expect(cs.status).toBe('CANCELLED');
        expect(cs.owner ?? null).toBeNull();
        await expectWorkload(op.page, 3);
      } else {
        await expectErr(rCancel, 409, 'CANNOT_CANCEL');
        expect(cs.status).toBe('IN_REVIEW');
        expect(cs.owner).toBe('off.reg1');
        await expectWorkload(op.page, 4);
      }
    });
  });
});

// ═════════════════════════════════════════ §5 UPLOAD ═════════════════════════════════════════

test.describe('UPLOAD', () => {
  test('TC-UPLOAD-01 · ขนาดและจำนวนไฟล์', async ({ h }) => {
    await h.reset();
    const { page, api } = await h.citizenPage(CIT.somchai);
    await wizardToUpload(page, 'SV-01', { qty: 1 });
    const d = await createDraft(api, 'SV-01', { qty: 1 }); // ร่างสำหรับตรวจ API

    await test.step('ขนาด', async () => {
      for (const n of [5242879, 5242880]) {
        const name = `size-${n}.pdf`;
        await uiUpload(page, 'id-card', tf(name));
        // B14: ใส่ชื่อไฟล์ในข้อความ assert ให้รู้ว่าขอบไหนล้ม (BUGS.md §3 ขั้น 4) · ค่าคาดหวังเดิม
        await expect(tid(page, 'file-item'), `${name} (${n} ไบต์ ≤ 5,242,880) ต้องถูกรับ`).toHaveCount(1);
        await expect(tid(page, 'upload-error')).toBeHidden();
        await uiRemoveFile(page, name);
        await expectOk(await uploadFile(api, d.draftId, 'id-card', tf(name)), 201);
      }
      await uiUpload(page, 'id-card', tf('size-5242881.pdf'));
      await expect(tid(page, 'upload-error')).toHaveText('ไฟล์ใหญ่เกิน 5 MB');
      await expect(tid(page, 'file-item')).toHaveCount(0);
      await expectErr(await uploadFile(api, d.draftId, 'id-card', tf('size-5242881.pdf')), 400, 'FILE_TOO_LARGE', 'ไฟล์ใหญ่เกิน 5 MB');
    });

    await test.step('จำนวน', async () => {
      await uiUpload(page, 'id-card', tf('id-card.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(1);
      await uiUpload(page, 'extra', ['multi-1.pdf', 'multi-2.pdf', 'multi-3.pdf', 'multi-4.pdf'].map((n) => tf(n)));
      await expect(tid(page, 'file-item')).toHaveCount(5);

      await uiUpload(page, 'extra', tf('multi-5.pdf'));
      await expect(tid(page, 'upload-error')).toHaveText('แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
      await expect(tid(page, 'file-item')).toHaveCount(5);

      await uiRemoveFile(page, 'multi-4.pdf');
      await expect(tid(page, 'file-item')).toHaveCount(4);
      await uiUpload(page, 'extra', tf('multi-5.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(5);
      await expect(byAttr(page, 'file-item', 'data-name', 'multi-5.pdf')).toHaveCount(1);

      // API: ร่าง API มี 2 ไฟล์แล้ว → เพิ่ม 3 = 5 → ไฟล์ที่ 6 ปฏิเสธ
      for (const n of ['multi-1.pdf', 'multi-2.pdf', 'multi-3.pdf'])
        await expectOk(await uploadFile(api, d.draftId, 'extra', tf(n)), 201);
      await expectErr(await uploadFile(api, d.draftId, 'extra', tf('multi-5.pdf')), 400, 'FILE_COUNT', 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
    });
  });

  test('TC-UPLOAD-02 · ชนิดไฟล์จากเนื้อไฟล์', async ({ h }) => {
    await h.reset();
    const { page, api } = await h.citizenPage(CIT.somchai);
    await wizardToUpload(page, 'SV-01', { qty: 1 });
    const d = await createDraft(api, 'SV-01', { qty: 1 });

    await test.step('รับ PDF/JPEG/PNG', async () => {
      for (const n of ['ok-id.pdf', 'real.jpg', 'real.png']) {
        await uiUpload(page, 'id-card', tf(n));
        await expect(tid(page, 'file-item')).toHaveCount(1);
        await uiRemoveFile(page, n);
        await expectOk(await uploadFile(api, d.draftId, 'id-card', tf(n)), 201);
      }
    });

    await test.step('ปฏิเสธจากเนื้อไฟล์', async () => {
      const before = await body(await api.get(`/api/drafts/${d.draftId}`));
      const rejects = [
        tf('fake-text.pdf'),
        tf('fake-text.jpg'),
        tf('exe-as.png'),
        tf('notes.txt'),
        tf('fake-text.pdf', 'application/pdf'), // ไม่เชื่อ Content-Type
      ];
      for (const f of rejects) {
        await uiUpload(page, 'id-card', f);
        await expect(tid(page, 'upload-error')).toHaveText('รองรับเฉพาะไฟล์ PDF, JPG, PNG');
        await expect(tid(page, 'file-item')).toHaveCount(0);
        await expectErr(await uploadFile(api, d.draftId, 'id-card', f), 400, 'FILE_TYPE', 'รองรับเฉพาะไฟล์ PDF, JPG, PNG');
      }
      await expectErr(
        await uploadFile(api, d.draftId, 'id-card', tf('fake-text.pdf', 'text/plain')),
        400,
        'FILE_TYPE',
      );
      const after = await body(await api.get(`/api/drafts/${d.draftId}`));
      expect(after, 'ไฟล์ที่ปฏิเสธไม่ถูกเก็บ').toEqual(before);
      await expect(tid(page, 'file-item')).toHaveCount(0);
    });
  });
});

// ═════════════════════════════════════════ §6 PAY ═════════════════════════════════════════

test.describe('PAY', () => {
  test('TC-PAY-01 · อายุ QR 15:00', async ({ h }) => {
    await test.step('รอบ 1: 09:00:00 (อายุ 5:00) → PAID', async () => {
      await h.reset();
      await h.citizen(CIT.somchai);
      const b = await expectOk(await h.pay('PP-0001', 500));
      expect(b).toMatchObject({ status: 'PAID', caseNo: cn(31) });
    });

    await test.step('รอบ 2: 09:09:59 (อายุ 14:59) → PAID', async () => {
      await h.reset();
      await h.clock('2026-12-01T09:09:59+07:00');
      await h.citizen(CIT.somchai);
      const b = await expectOk(await h.pay('PP-0001', 500));
      expect(b).toMatchObject({ status: 'PAID', caseNo: cn(31) });
    });

    await test.step('รอบ 3: 09:10:00 (อายุ 15:00) → 410', async () => {
      await h.reset();
      await h.clock('2026-12-01T09:10:00+07:00');
      const { page, api } = await h.citizenPage(CIT.somchai);
      await expectErr(await h.pay('PP-0001', 500), 410, 'QR_EXPIRED');
      expect((await expectOk(await getPayment(api, 'PP-0001'))).status).toBe('EXPIRED');
      expect((await myCases(api)).length).toBe(10);

      await page.goto('/citizen/new/SV-02?draft=DR-0002');
      await expect(tid(page, 'qr-expired-msg')).toHaveText('QR หมดอายุ กรุณาสร้าง QR ใหม่');
      await expect(tid(page, 'payment-status')).toHaveText('QR หมดอายุ');
      await expect(tid(page, 'payment-status')).toHaveAttribute('data-status', 'EXPIRED');
      await expect(tid(page, 'regenerate-qr-btn')).toHaveCount(1);
      await tid(page, 'regenerate-qr-btn').click();
      await expect(tid(page, 'qr-ref')).toHaveText('PP-0002');
      await expect(tid(page, 'qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');
      const b = await expectOk(await h.pay('PP-0002', 500));
      expect(b).toMatchObject({ status: 'PAID', caseNo: cn(31) });
    });

    await test.step('รอบ 4: 09:10:01 (อายุ 15:01) → 410', async () => {
      await h.reset();
      await h.clock('2026-12-01T09:10:01+07:00');
      await h.citizen(CIT.somchai);
      await expectErr(await h.pay('PP-0001', 500), 410, 'QR_EXPIRED');
    });
  });

  test('TC-PAY-02 · ยอดเงินและ callback ซ้ำ', async ({ h }) => {
    await h.reset();
    const { api } = await h.citizen(CIT.somchai);
    const p = await newPending(api, 'SV-01', { qty: 1 });
    expect(p.ref).toBe('PP-0002');
    expect(p.fee).toBe(20);

    await test.step('1–2: ยอดไม่ตรง 422', async () => {
      for (const amt of [19, 21]) {
        await expectErr(await h.pay('PP-0002', amt), 422, 'AMOUNT_MISMATCH');
        expect((await expectOk(await getPayment(api, 'PP-0002'))).status).toBe('PENDING');
        expect((await myCases(api)).length).toBe(10);
      }
    });

    await test.step('3: ยอดตรง', async () => {
      const b = await expectOk(await h.pay('PP-0002', 20));
      expect(b).toMatchObject({ status: 'PAID', caseNo: cn(31), receiptNo: rc(31) });
      expect((await myCases(api)).length).toBe(11);
    });

    await test.step('4: callback ซ้ำ', async () => {
      const b = await expectOk(await h.pay('PP-0002', 20));
      expect(b).toMatchObject({ duplicate: true, caseNo: cn(31), receiptNo: rc(31) });
      expect((await myCases(api)).length).toBe(11);
    });

    await test.step('5: ใบถัดไปไม่ข้ามเลข', async () => {
      const r = await payNew(api, 'SV-01', { qty: 1 });
      expect(r.caseNo).toBe(cn(32));
      expect(r.receiptNo).toBe(rc(32));
    });
  });

  test('TC-PAY-03 · ชำระพร้อมกัน เลขไม่ซ้ำ', async ({ h }) => {
    await h.reset();
    const somchai = await h.citizen(CIT.somchai);
    const somying = await h.citizen(CIT.somying);
    const mine: Record<string, string[]> = { somchai: [], somying: [] };
    for (const [who, a] of [
      ['somchai', somchai],
      ['somying', somying],
    ] as const) {
      for (let i = 0; i < 3; i++) mine[who].push((await newPending(a.api, 'SV-01', { qty: 1 })).ref);
    }
    expect([...mine.somchai, ...mine.somying].sort()).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);

    const refs = [...mine.somchai, ...mine.somying];
    const hook = await h.anonApi();
    const resps = await Promise.all(refs.map((ref) => hook.post(`/api/test/payments/${ref}/pay`, { data: { amount: 20 } })));
    const results = await Promise.all(resps.map((r) => expectOk(r)));
    const byRef = Object.fromEntries(refs.map((r, i) => [r, results[i]]));

    expect(results.map((r) => r.caseNo).sort()).toEqual([31, 32, 33, 34, 35, 36].map((n) => cn(n)));
    expect(results.map((r) => r.receiptNo).sort()).toEqual([31, 32, 33, 34, 35, 36].map((n) => rc(n)));

    const somchaiCases = (await myCases(somchai.api)).map((c) => c.caseNo);
    const somyingCases = (await myCases(somying.api)).map((c) => c.caseNo);
    expect(somchaiCases.length).toBe(13);
    expect(somyingCases.length).toBe(14);
    for (const ref of mine.somchai) expect(somchaiCases).toContain(byRef[ref].caseNo);
    for (const ref of mine.somying) expect(somyingCases).toContain(byRef[ref].caseNo);

    const next = await payNew(somchai.api, 'SV-01', { qty: 1 });
    expect(next.caseNo).toBe(cn(37));
  });

  test('TC-PAY-04 · เลขคำขอข้ามปี', async ({ h }) => {
    await h.reset();
    await h.clock('2026-12-31T23:58:00+07:00');
    const { page, api } = await h.citizenPage(CIT.somchai);

    let ref = '';
    await test.step('1: 23:58 สร้างร่าง + QR', async () => {
      await wizardToUpload(page, 'SV-01', { qty: 1 });
      await uiUpload(page, 'id-card', tf('id-card.pdf'));
      await expect(tid(page, 'file-item')).toHaveCount(1);
      await tid(page, 'to-payment-btn').click();
      await tid(page, 'create-qr-btn').click();
      ref = (await tid(page, 'qr-ref').innerText()).trim();
      expect(ref).toBe('PP-0002');
      const g = await expectOk(await getPayment(api, ref));
      expect(g.status).toBe('PENDING');
      expect(g.caseNo ?? null).toBeNull();
      expect((await myCases(api)).length).toBe(10);
    });

    await test.step('2: 23:59 ชำระ', async () => {
      await h.clock('2026-12-31T23:59:00+07:00');
      const b = await expectOk(await h.pay(ref, 20));
      expect(b).toMatchObject({ caseNo: cn(31), receiptNo: rc(31) });
      await tid(page, 'refresh-payment-btn').click();
      await expect(tid(page, 'submitted-case-no')).toHaveText(cn(31));
      await expect(tid(page, 'receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-31T23:59:00+07:00');
    });

    await test.step('3–4: 2027-01-01 00:00 เลขปี 2570', async () => {
      await h.clock('2027-01-01T00:00:00+07:00');
      const a = await payNew(api, 'SV-01', { qty: 1 });
      expect(a.caseNo).toBe(cn(1, 2570));
      expect(a.receiptNo).toBe(rc(1, 2570));
      const b = await payNew(api, 'SV-01', { qty: 1 });
      expect(b.caseNo).toBe(cn(2, 2570));
    });

    await test.step('5: เลขเดิมไม่เปลี่ยน', async () => {
      expect((await getCase(api, cn(31))).caseNo).toBe(cn(31));
    });
  });
});

// ═════════════════════════════════════════ §7 QUEUE ═════════════════════════════════════════

const REG_QUEUE = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map((n) => cn(n));

test.describe('QUEUE', () => {
  test('TC-QUEUE-01 · ลำดับคิวและขอบเขตแผนก', async ({ h }) => {
    await h.reset();

    await test.step('off.reg1 · all', async () => {
      const { page } = await h.staffPage('off.reg1');
      await openQueue(page);
      await expect(tid(page, 'queue-filter')).toHaveValue('all');
      await expect(tid(page, 'queue-row')).toHaveCount(17);
      await expectQueue(page, REG_QUEUE);
      await expect(tid(page, 'row-sla-level').nth(0)).toHaveText('เกินกำหนด');
      await expect(tid(page, 'row-sla-level').nth(1)).toHaveText('ใกล้ครบกำหนด');
      await expect(tid(page, 'row-sla-level').nth(2)).toHaveText('ใกล้ครบกำหนด');
      for (const t of await tid(page, 'row-id-masked').allInnerTexts()) expect(t.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
      await expect(tid(page, 'row-id-masked')).toHaveCount(17);

      await expect(tid(page, 'claim-btn')).toHaveCount(4);
      const withClaim = await page
        .locator('[data-testid="queue-row"]:has([data-testid="claim-btn"])')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-case-no')));
      expect(withClaim).toEqual([24, 28, 29, 30].map((n) => cn(n)));
      for (const n of [17, 11, 14]) await expect(byAttr(page, 'queue-row', 'data-case-no', cn(n))).toHaveCount(0);

      await openQueue(page, 'unclaimed');
      await expectQueue(page, [24, 28, 29, 30].map((n) => cn(n)));
      await openQueue(page, 'mine');
      await expectQueue(page, [20, 22, 23].map((n) => cn(n)));
      await expect(tid(page, 'workload-count')).toHaveText('3');
    });

    await test.step('off.reg2 · mine', async () => {
      const { page } = await h.staffPage('off.reg2');
      await openQueue(page, 'mine');
      await expectQueue(page, [25, 26, 13, 15, 27, 16, 18, 12, 21].map((n) => cn(n)));
      await expect(tid(page, 'workload-count')).toHaveText('9');
    });

    await test.step('off.works1 · เห็นเฉพาะโยธา', async () => {
      const { page } = await h.staffPage('off.works1');
      await openQueue(page);
      await expectQueue(page, [cn(10)]);
    });

    await test.step('head1 · 18 แถว อ่านอย่างเดียว', async () => {
      const { page } = await h.staffPage('head1');
      await openQueue(page);
      await expect(tid(page, 'queue-row')).toHaveCount(18);
      const list = await queueCaseNos(page);
      const i = list.indexOf(cn(10));
      expect(list.slice(i, i + 4)).toEqual([10, 23, 25, 26].map((n) => cn(n)));
      expect(list.filter((c) => c !== cn(10))).toEqual(REG_QUEUE);
      await expect(tid(page, 'claim-btn')).toHaveCount(0);
    });
  });

  test('TC-QUEUE-02 · รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ h }) => {
    await test.step('ส่วน 1 พร้อมกัน (UI)', async () => {
      await h.reset();
      const A = await h.staffPage('off.reg1');
      const B = await h.staffPage('off.reg2');
      await A.page.goto('/officer/queue');
      await B.page.goto('/officer/queue');
      const btnA = byAttr(A.page, 'queue-row', 'data-case-no', cn(28)).getByTestId('claim-btn');
      const btnB = byAttr(B.page, 'queue-row', 'data-case-no', cn(28)).getByTestId('claim-btn');
      await expect(btnA).toBeVisible();
      await expect(btnB).toBeVisible();
      await Promise.all([btnA.click(), btnB.click()]);

      const cs = await getCase(A.api, cn(28));
      expect(['off.reg1', 'off.reg2']).toContain(cs.owner);
      expect(cs.status).toBe('IN_REVIEW');
      const [win, lose] = cs.owner === 'off.reg1' ? [A, B] : [B, A];
      // B14: รอผลที่แน่นอนบนหน้าของคนที่ไม่ได้เรื่อง (action-error หรือ action-success) แล้วเทียบข้อความ
      // ถ้าเว็บให้รับซ้อนได้ (B08) จะล้มด้วยค่าจริง "รับเรื่อง … แล้ว" แทน "หา element ไม่เจอ" (BUGS.md §5) · ค่าคาดหวังเดิม
      await expect(
        tid(lose.page, 'action-error').or(tid(lose.page, 'action-success')),
        `${lose === A ? 'off.reg1' : 'off.reg2'} กดรับ ${cn(28)} พร้อมกัน ต้องได้ ALREADY_CLAIMED`,
      ).toHaveText('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
      await win.page.goto('/officer/queue');
      const row = byAttr(win.page, 'queue-row', 'data-case-no', cn(28));
      await expect(row).toHaveAttribute('data-owner', cs.owner);
      await expect(row.getByTestId('row-owner')).toHaveText(new RegExp(`${cs.owner.replace('.', '\\.')}|${STAFF_NAME[cs.owner]}`));
      expect(await h.auditCount('CLAIM', cn(28))).toBe(1);
    });

    await test.step('ส่วน 2 พร้อมกัน 10 ครั้ง (API · RESET)', async () => {
      await h.reset();
      const r1 = await h.staff('off.reg1');
      const r2 = await h.staff('off.reg2');
      const who = [...Array(5).fill('off.reg1'), ...Array(5).fill('off.reg2')] as string[];
      const resps = await Promise.all(who.map((u) => claim(u === 'off.reg1' ? r1.api : r2.api, cn(29))));
      const okIdx = resps.map((r, i) => (r.status() === 200 ? i : -1)).filter((i) => i >= 0);
      expect(okIdx.length).toBe(1);
      for (const [i, r] of resps.entries()) if (i !== okIdx[0]) await expectErr(r, 409, 'ALREADY_CLAIMED');
      expect((await getCase(r1.api, cn(29))).owner).toBe(who[okIdx[0]]);
      expect(await h.auditCount('CLAIM', cn(29))).toBe(1);
    });

    await test.step('ส่วน 3 ต่อกัน (RESET)', async () => {
      await h.reset();
      const r1 = await h.staff('off.reg1');
      const r2 = await h.staff('off.reg2');
      expect(await expectOk(await claim(r1.api, cn(29)))).toMatchObject({ owner: 'off.reg1' });
      await expectErr(await claim(r2.api, cn(29)), 409, 'ALREADY_CLAIMED', 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
      expect((await getCase(r1.api, cn(29))).owner).toBe('off.reg1');
      const p2 = await h.staffPage('off.reg2');
      await expectWorkload(p2.page, 9);
      await expectErr(await claim(r1.api, cn(29)), 409);
      expect(await h.auditCount('CLAIM', cn(29))).toBe(1);
    });
  });

  test('TC-QUEUE-03 · งานในมือสูงสุด 10', async ({ h }) => {
    await h.reset();
    const R2 = await h.staffPage('off.reg2');
    const page = R2.page;
    const clickClaim = async (n: number) => {
      await page.goto('/officer/queue');
      await byAttr(page, 'queue-row', 'data-case-no', cn(n)).getByTestId('claim-btn').click();
    };

    await test.step('1: งานในมือ 9', async () => {
      await expectWorkload(page, 9);
    });
    await test.step('2: รับ 000028 → 10', async () => {
      await clickClaim(28);
      await expect(tid(page, 'action-error')).toBeHidden();
      await expectWorkload(page, 10);
    });
    await test.step('3: รับ 000029 → เกินเพดาน', async () => {
      await clickClaim(29);
      await expect(tid(page, 'action-error')).toHaveText('รับงานได้สูงสุด 10 เรื่อง');
      await expectErr(await claim(R2.api, cn(29)), 409, 'WORKLOAD_LIMIT', 'รับงานได้สูงสุด 10 เรื่อง');
      const cs = await getCase(R2.api, cn(29));
      expect(cs.status).toBe('SUBMITTED');
      expect(cs.owner ?? null).toBeNull();
      await expectWorkload(page, 10);
    });
    await test.step('4: อนุมัติ 000025 → 9', async () => {
      await page.goto(`/officer/cases/${cn(25)}`);
      await tid(page, 'approve-btn').click();
      await expect(tid(page, 'case-status')).toHaveAttribute('data-status', 'APPROVED');
      await expectWorkload(page, 9);
    });
    await test.step('5: รับ 000029 อีกครั้ง → 10', async () => {
      await clickClaim(29);
      await expect(tid(page, 'action-error')).toBeHidden();
      await expectWorkload(page, 10);
    });
    await test.step('6: off.reg1 รับ 000030 สำเร็จ', async () => {
      const r1 = await h.staff('off.reg1');
      await expectOk(await claim(r1.api, cn(30)));
    });

    await test.step('7–10: RESET · NEED_FIX ไม่นับ · ส่งแก้คืนผู้ถือแม้เกิน 10', async () => {
      await h.reset();
      const R = await h.staffPage('off.reg2');
      await R.page.goto(`/officer/cases/${cn(25)}`);
      await tid(R.page, 'return-btn').click();
      await tid(R.page, 'return-reason').fill('xxxxxxxxxx');
      await tid(R.page, 'return-submit').click();
      await expect(tid(R.page, 'case-status')).toHaveText('รอแก้ไขเอกสาร');
      await expectWorkload(R.page, 8);

      await expectOk(await claim(R.api, cn(28)));
      await expectOk(await claim(R.api, cn(29)));
      await expectWorkload(R.page, 10);

      const S = await h.citizenPage(CIT.somying);
      await S.page.goto(`/citizen/cases/${cn(25)}`);
      await tid(S.page, 'submit-fix-btn').click();
      await expect(tid(S.page, 'action-error')).toBeHidden();
      await expect(tid(S.page, 'case-status')).toHaveText('กำลังตรวจสอบ');
      expect((await getCase(R.api, cn(25))).owner).toBe('off.reg2');
      await expectWorkload(R.page, 11);

      await expectErr(await claim(R.api, cn(30)), 409, 'WORKLOAD_LIMIT', 'รับงานได้สูงสุด 10 เรื่อง');
      await expectWorkload(R.page, 11);
    });
  });
});

// ═════════════════════════════════════════ §8 SLA ═════════════════════════════════════════

test.describe('SLA', () => {
  test('TC-SLA-01 · กำหนดเสร็จตามตารางวันที่', async ({ h }) => {
    const rows: Array<[string, ServiceId, string, string, string]> = [
      ['a', 'SV-01', '2026-12-01T09:00:00+07:00', '2026-12-04T16:30:00+07:00', '4 ธ.ค. 2569 16:30'],
      ['b', 'SV-01', '2026-12-01T16:29:00+07:00', '2026-12-04T16:30:00+07:00', '4 ธ.ค. 2569 16:30'],
      ['c', 'SV-01', '2026-12-01T16:30:00+07:00', '2026-12-08T16:30:00+07:00', '8 ธ.ค. 2569 16:30'],
      ['d', 'SV-01', '2026-12-04T10:00:00+07:00', '2026-12-11T16:30:00+07:00', '11 ธ.ค. 2569 16:30'],
      ['e', 'SV-01', '2026-12-05T10:00:00+07:00', '2026-12-14T16:30:00+07:00', '14 ธ.ค. 2569 16:30'],
      ['f', 'SV-02', '2026-12-01T09:00:00+07:00', '2026-12-17T16:30:00+07:00', '17 ธ.ค. 2569 16:30'],
      ['g', 'SV-03', '2026-12-01T09:00:00+07:00', '2026-12-24T16:30:00+07:00', '24 ธ.ค. 2569 16:30'],
      ['h', 'SV-01', '2026-12-29T10:00:00+07:00', '2027-01-05T16:30:00+07:00', '5 ม.ค. 2570 16:30'],
      ['i', 'SV-01', '2026-12-31T23:59:00+07:00', '2027-01-07T16:30:00+07:00', '7 ม.ค. 2570 16:30'],
    ];
    for (const [label, sv, at, due, text] of rows) {
      await test.step(`แถว ${label}: ${sv} ชำระ ${at} → ${due}`, async () => {
        await h.reset();
        await h.clock(at);
        const { page, api } = await h.citizenPage(CIT.somchai);
        const r = await payNew(api, sv, sv === 'SV-03' ? { areaSqm: 100 } : { qty: 1 });
        expect(r.caseNo).toBe(cn(31));
        expect((await getCase(api, cn(31))).dueAt).toBe(due);
        await page.goto(`/citizen/cases/${cn(31)}`);
        await expect(tid(page, 'sla-due')).toHaveAttribute('data-iso', due);
        await expect(tid(page, 'sla-due')).toHaveText(text);
      });
    }
  });

  test('TC-SLA-02 · หยุดนับ SLA ระหว่างรอแก้ไข', async ({ h }) => {
    await test.step('ส่วน 1: ตีกลับ 2 ธ.ค. 11:00 ส่งแก้ 3 ธ.ค. 10:00', async () => {
      await h.reset();
      const p = await h.newPaid('SV-01', { at: '2026-12-01T09:00:00+07:00', qty: 1 });
      expect(p.caseNo).toBe(cn(31));
      expect((await getCase(p.api, cn(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');

      await h.clock('2026-12-02T11:00:00+07:00');
      const O = await h.staffPage('off.reg1');
      await expectOk(await claim(O.api, cn(31)));
      await expectOk(await returnCase(O.api, cn(31), 'xxxxxxxxxx'));
      await O.page.goto(`/officer/cases/${cn(31)}`);
      await expect(tid(O.page, 'case-status')).toHaveText('รอแก้ไขเอกสาร');

      const C = await h.citizenPage(CIT.somchai);
      await C.page.goto(`/citizen/cases/${cn(31)}`);
      await expect(tid(C.page, 'case-status')).toHaveText('รอแก้ไขเอกสาร');
      await expect(tid(C.page, 'sla-level')).toHaveText('หยุดนับ');
      await expect(tid(C.page, 'sla-level')).toHaveAttribute('data-level', 'paused');
      await expect(tid(C.page, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-09T11:00:00+07:00');

      await h.clock('2026-12-03T10:00:00+07:00');
      const C2 = await h.citizenPage(CIT.somchai); // ล็อกอินใหม่หลังเลื่อนนาฬิกา
      await C2.page.goto(`/citizen/cases/${cn(31)}`);
      await tid(C2.page, 'submit-fix-btn').click();
      await expect(tid(C2.page, 'case-status')).toHaveText('กำลังตรวจสอบ');
      await C2.page.goto(`/citizen/cases/${cn(31)}`);
      await expect(tid(C2.page, 'case-status')).toHaveAttribute('data-status', 'IN_REVIEW');
      await expect(tid(C2.page, 'sla-due')).toHaveText('8 ธ.ค. 2569 16:30');
      await expect(tid(C2.page, 'sla-due')).toHaveAttribute('data-iso', '2026-12-08T16:30:00+07:00');
      await expect(tid(C2.page, 'sla-level')).toHaveText('ปกติ');
      expect((await getCase(C2.api, cn(31))).dueAt).toBe('2026-12-08T16:30:00+07:00');

      const O2 = await h.staffPage('off.reg1');
      await O2.page.goto(`/officer/cases/${cn(31)}`);
      await expect(tid(O2.page, 'case-owner')).toHaveText('off.reg1');
    });

    await test.step('ส่วน 2: seed 000017 ส่งแก้ 1 ธ.ค. 09:00', async () => {
      await h.reset();
      const C = await h.citizenPage(CIT.somchai);
      await C.page.goto(`/citizen/cases/${cn(17)}`);
      await expect(tid(C.page, 'sla-level')).toHaveText('หยุดนับ');
      await expect(tid(C.page, 'sla-due')).toHaveAttribute('data-iso', '2026-11-27T16:30:00+07:00');
      await tid(C.page, 'submit-fix-btn').click();
      await expect(tid(C.page, 'case-status')).toHaveText('กำลังตรวจสอบ');
      await C.page.goto(`/citizen/cases/${cn(17)}`);
      await expect(tid(C.page, 'sla-level')).toHaveText('ใกล้ครบกำหนด');
      await expect(tid(C.page, 'sla-due')).toHaveAttribute('data-iso', '2026-12-01T16:30:00+07:00');
      expect((await getCase(C.api, cn(17))).dueAt).toBe('2026-12-01T16:30:00+07:00');
      const O = await h.staff('off.reg1');
      expect((await getCase(O.api, cn(17))).owner).toBe('off.reg1');
    });

    await test.step('ส่วน 3: seed 000017 ส่งแก้ 4 ธ.ค. 10:00', async () => {
      await h.reset();
      await h.clock('2026-12-04T10:00:00+07:00');
      const C = await h.citizen(CIT.somchai);
      const b = await expectOk(await resubmit(C.api, cn(17)));
      expect(b.dueAt).toBe('2026-12-04T16:30:00+07:00');
      const cs = await getCase(C.api, cn(17));
      expect(cs.dueAt).toBe('2026-12-04T16:30:00+07:00');
      expect(cs.slaLevel).toBe('near');
    });

    await test.step('ส่วน 4: ตีกลับและส่งแก้วันเดียวกัน', async () => {
      await h.reset();
      const p = await h.newPaid('SV-01', { at: '2026-12-01T09:00:00+07:00', qty: 1 });
      await h.clock('2026-12-02T09:00:00+07:00');
      const O = await h.staff('off.reg1');
      await expectOk(await claim(O.api, p.caseNo));
      await expectOk(await returnCase(O.api, p.caseNo, 'xxxxxxxxxx'));
      await h.clock('2026-12-02T15:00:00+07:00');
      const C = await h.citizen(CIT.somchai);
      await expectOk(await resubmit(C.api, p.caseNo));
      expect((await getCase(C.api, p.caseNo)).dueAt).toBe('2026-12-04T16:30:00+07:00');
    });

    await test.step('ส่วน 5: คร่อมสุดสัปดาห์/วันหยุด ส่งแก้หลัง 16:30', async () => {
      await h.reset();
      const p = await h.newPaid('SV-01', { at: '2026-12-01T09:00:00+07:00', qty: 1 });
      await h.clock('2026-12-04T10:00:00+07:00');
      const O = await h.staff('off.reg1');
      await expectOk(await claim(O.api, p.caseNo));
      await expectOk(await returnCase(O.api, p.caseNo, 'xxxxxxxxxx'));
      await h.clock('2026-12-08T17:00:00+07:00');
      const C = await h.citizenPage(CIT.somchai);
      await expectOk(await resubmit(C.api, p.caseNo));
      const cs = await getCase(C.api, p.caseNo);
      expect(cs.dueAt).toBe('2026-12-08T16:30:00+07:00');
      expect(cs.slaLevel).toBe('overdue');
      await C.page.goto(`/citizen/cases/${p.caseNo}`);
      await expect(tid(C.page, 'sla-level')).toHaveText('เกินกำหนด');
    });
  });

  test('TC-SLA-03 · ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด', async ({ h }) => {
    const LV: Record<string, string> = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด' };

    await test.step('ส่วน A: คำขอใหม่ 000031 กำหนด 4 ธ.ค. 16:30', async () => {
      await h.reset();
      await h.newPaid('SV-01', { at: '2026-12-01T09:00:00+07:00', qty: 1 });
      const rows: Array<[string, string]> = [
        ['2026-12-01T09:00:00+07:00', 'normal'],
        ['2026-12-02T09:00:00+07:00', 'normal'],
        ['2026-12-03T09:00:00+07:00', 'near'],
        ['2026-12-04T16:30:00+07:00', 'near'],
        ['2026-12-04T16:30:01+07:00', 'overdue'],
        ['2026-12-04T16:31:00+07:00', 'overdue'],
        ['2026-12-05T10:00:00+07:00', 'overdue'],
      ];
      for (const [t, lv] of rows) {
        await h.clock(t);
        const C = await h.citizenPage(CIT.somchai);
        await C.page.goto(`/citizen/cases/${cn(31)}`);
        await expect(tid(C.page, 'sla-level'), t).toHaveText(LV[lv]);
        await expect(tid(C.page, 'sla-level'), t).toHaveAttribute('data-level', lv);
        expect((await getCase(C.api, cn(31))).slaLevel, t).toBe(lv);
      }
    });

    await test.step('ส่วน B: seed 000016 กำหนด 8 ธ.ค. 16:30', async () => {
      await h.reset();
      const rows: Array<[string, string]> = [
        ['2026-12-03T09:00:00+07:00', 'normal'],
        ['2026-12-04T09:00:00+07:00', 'near'],
        ['2026-12-08T16:30:00+07:00', 'near'],
        ['2026-12-08T16:31:00+07:00', 'overdue'],
      ];
      for (const [t, lv] of rows) {
        await h.clock(t);
        const P = await h.citizenPage(CIT.piti); // ผู้ยื่น 000016 = ปิติ
        await P.page.goto(`/citizen/cases/${cn(16)}`);
        await expect(tid(P.page, 'sla-level'), t).toHaveText(LV[lv]);
        expect((await getCase(P.api, cn(16))).slaLevel, t).toBe(lv);
      }
    });

    await test.step('ส่วน C: seed ณ 09:00', async () => {
      await h.reset();
      const O = await h.staffPage('off.reg1');
      await O.page.goto('/officer/queue');
      const exp: Array<[number, string]> = [
        [20, 'เกินกำหนด'],
        [22, 'ใกล้ครบกำหนด'],
        [24, 'ใกล้ครบกำหนด'],
        [25, 'ปกติ'],
      ];
      for (const [n, text] of exp)
        await expect(byAttr(O.page, 'queue-row', 'data-case-no', cn(n)).getByTestId('row-sla-level')).toHaveText(text);
      for (const [n, text] of exp) {
        await O.page.goto(`/officer/cases/${cn(n)}`);
        await expect(tid(O.page, 'sla-level')).toHaveText(text);
      }
      await O.page.goto(`/officer/cases/${cn(17)}`);
      await expect(tid(O.page, 'sla-level')).toHaveText('หยุดนับ');
      await expect(tid(O.page, 'sla-level')).toHaveAttribute('data-level', 'paused');

      const S = await h.citizenPage(CIT.somying);
      await S.page.goto(`/citizen/cases/${cn(1)}`);
      await expect(tid(S.page, 'sla-level')).toHaveText('ปิดแล้ว');
      await expect(tid(S.page, 'sla-level')).toHaveAttribute('data-level', 'closed');

      for (const [t, text] of [
        ['2026-12-01T16:30:00+07:00', 'ใกล้ครบกำหนด'],
        ['2026-12-01T16:31:00+07:00', 'เกินกำหนด'],
      ]) {
        await h.clock(t);
        const O2 = await h.staffPage('off.reg1');
        await O2.page.goto('/officer/queue');
        await expect(byAttr(O2.page, 'queue-row', 'data-case-no', cn(22)).getByTestId('row-sla-level'), t).toHaveText(text);
      }
    });
  });
});

// ═════════════════════════════════════════ §9 NOTI ═════════════════════════════════════════

/** TC-NOTI-01 ทั้งการ์ด (ใช้ซ้ำใน TC-NOTI-02 ส่วน A) · คืน actor ที่ล็อกอินไว้ */
async function notiScenario01(h: Harness) {
  await h.reset(); // หลังนี้ห้ามมี request อื่นก่อน LOGIN_S off.reg1
  const reg1 = await h.staffPage('off.reg1'); // request แรกที่ 09:00 กระตุ้นการประเมิน
  const reg2 = await h.staffPage('off.reg2');
  const head = await h.staffPage('head1');
  const works = await h.staffPage('off.works1');

  const exp09 = {
    reg1: pairs([
      [24, 'near'],
      [22, 'near'],
      [20, 'overdue'],
    ]),
    reg2: pairs([[24, 'near']]),
    head: pairs([[20, 'overdue']]),
  };
  for (const [a, e] of [
    [reg1, exp09.reg1],
    [reg2, exp09.reg2],
    [head, exp09.head],
  ] as const) {
    expect(await uiNotiPairs(a.page)).toEqual(e);
    await expect(tid(a.page, 'bell-count')).toHaveText(String(e.length));
    expect(await notiPairs(a.api)).toEqual(e);
  }
  await expect(byAttr(reg1.page, 'noti-item', 'data-case-no', cn(24))).toContainText(`คำขอ ${cn(24)} ใกล้ครบกำหนด`);
  await expect(byAttr(reg1.page, 'noti-item', 'data-case-no', cn(20))).toContainText(`คำขอ ${cn(20)} เกินกำหนด`);

  expect(await uiNotiPairs(works.page)).toEqual([]);
  await expect(tid(works.page, 'noti-empty')).toHaveText('ไม่มีแจ้งเตือน');
  await expect(tid(works.page, 'bell-count')).toHaveText('0');
  expect(await notiPairs(works.api)).toEqual([]);

  // ต่อ: 16:31 + request ใด ๆ (ล็อกอินใหม่ = request แรกหลังเลื่อนนาฬิกา)
  await h.clock('2026-12-01T16:31:00+07:00');
  const reg1b = await h.staffPage('off.reg1');
  const headb = await h.staffPage('head1');
  const reg2b = await h.staffPage('off.reg2');
  const exp1631 = {
    reg1: pairs([
      [24, 'near'],
      [22, 'near'],
      [20, 'overdue'],
      [22, 'overdue'],
    ]),
    head: pairs([
      [20, 'overdue'],
      [22, 'overdue'],
    ]),
  };
  for (const [a, e] of [
    [reg1b, exp1631.reg1],
    [headb, exp1631.head],
    [reg2b, exp09.reg2],
  ] as const) {
    expect(await notiPairs(a.api)).toEqual(e);
    expect(await uiNotiPairs(a.page)).toEqual(e);
    await expect(tid(a.page, 'bell-count')).toHaveText(String(e.length));
  }
  return { reg1: reg1b, reg2: reg2b, head: headb, works };
}

test.describe('NOTI', () => {
  test('TC-NOTI-01 · ผู้รับแจ้งเตือนตามระดับ', async ({ h }) => {
    await notiScenario01(h);
  });

  test('TC-NOTI-02 · ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ h }) => {
    await test.step('ส่วน A ไม่แจ้งซ้ำ', async () => {
      const { reg1, head } = await notiScenario01(h);
      for (const a of [reg1, head]) {
        for (let i = 0; i < 3; i++) await a.page.goto('/notifications');
        for (let i = 0; i < 3; i++) await notiPairs(a.api);
        for (let i = 0; i < 2; i++) await a.page.goto('/officer/queue');
      }
      for (const [a, n] of [
        [reg1, 4],
        [head, 2],
      ] as const) {
        const p = await notiPairs(a.api);
        expect(p.length).toBe(n);
        expect(new Set(p).size, 'ทุกคู่ (คำขอ, ระดับ) มีได้ 1 รายการ').toBe(p.length);
        await a.page.goto('/notifications');
        await expect(tid(a.page, 'bell-count')).toHaveText(String(n));
      }
    });

    await test.step('ส่วน B ข้ามระดับ (ประเมินครั้งแรก ส. 5 ธ.ค. 10:00)', async () => {
      await h.reset();
      await h.clock('2026-12-05T10:00:00+07:00');
      const reg1 = await h.staffPage('off.reg1');
      const reg2 = await h.staffPage('off.reg2');
      const works = await h.staffPage('off.works1');
      const head = await h.staffPage('head1');
      const ov = (ns: number[]) => ns.map((n) => [n, 'overdue'] as [number, 'overdue']);
      const exp = {
        reg1: pairs(ov([20, 22, 23, 24, 28, 29, 30])),
        reg2: pairs([...ov([13, 15, 24, 25, 26, 27, 28, 29, 30]), [16, 'near']]),
        works: pairs(ov([10])),
        head: pairs([...ov([10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30]), [11, 'near']]),
      };
      for (const [a, e, n] of [
        [reg1, exp.reg1, 7],
        [reg2, exp.reg2, 10],
        [works, exp.works, 1],
        [head, exp.head, 15],
      ] as const) {
        expect(await notiPairs(a.api)).toEqual(e);
        expect(await uiNotiPairs(a.page)).toEqual(e);
        await expect(tid(a.page, 'bell-count')).toHaveText(String(n));
      }
    });

    await test.step('ส่วน C ขั้นรออนุมัติและรอออกเอกสาร', async () => {
      await h.reset();
      /** ล็อกอินใหม่ (= request ที่นาฬิกาปัจจุบัน) แล้วอ่านแจ้งเตือนของคำขอ n */
      const of = async (user: string, n: number) =>
        (await notiPairs((await h.staff(user)).api)).filter((p) => p.startsWith(cn(n) + '|'));

      await h.clock('2026-12-04T09:00:00+07:00');
      expect(await of('head1', 14)).toEqual(pairs([[14, 'near']]));
      expect(await of('off.reg1', 14)).toEqual([]);
      expect(await of('off.reg2', 14)).toEqual([]);

      await h.clock('2026-12-04T16:31:00+07:00');
      expect(await of('head1', 14)).toEqual(
        pairs([
          [14, 'near'],
          [14, 'overdue'],
        ]),
      );
      expect(await of('off.reg1', 14)).toEqual([]);
      expect(await of('off.reg2', 14)).toEqual([]);

      await h.clock('2026-12-08T09:00:00+07:00');
      expect(await of('off.reg1', 19)).toEqual(pairs([[19, 'near']]));
      expect(await of('off.reg2', 19)).toEqual([]);
      expect(await of('head1', 19)).toEqual([]);

      await h.clock('2026-12-09T16:31:00+07:00');
      expect(await of('off.reg1', 19)).toEqual(
        pairs([
          [19, 'near'],
          [19, 'overdue'],
        ]),
      );
      expect(await of('head1', 19)).toEqual(pairs([[19, 'overdue']]));
    });
  });
});
