# BUG-HUNT · พิสูจน์ว่า test จับบั๊กได้จริง (BUG_MODE B01–B12)

> ตาม `egov-brief/BUGS.md` §3–§6 · รันวันที่ 17 พ.ย. 2569 บนเครื่อง host (Windows + Docker Desktop)
> เว็บ: `week2/egov-eservice/app` · `TEST_MODE=1 BUG_MODE=<รหัส> docker compose up -d --force-recreate` ทีละรอบ
> ชุดทดสอบ: Playwright ชุดเต็ม 51 TC (`app/tests`) · เว็บตัวที่ 2 ไม่เปิด TEST_MODE ที่พอร์ต 3001 สำหรับ TC-NFR-03
> ผลดิบแต่ละรอบ: `bug-runs/<รหัส>.json` · สคริปต์: `bug-runs/run-bugs.sh` · สรุป: `node bug-runs/summarize.js bug-runs/B01.json`
> ข้อมูลทดสอบทั้งหมดเป็นข้อมูลสมมติตาม TEST-DATA

## 1. ตารางบันทึกผล (BUGS.md §4)

| บั๊ก | TC ที่คาดว่าล้ม (จากตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed (ก่อนเริ่ม 2 รอบติด · หลัง B12 · หลังรอบรวมบั๊ก) |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | 50 passed · 1 failed ✅ |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | 50 passed · 1 failed ✅ |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-RBAC-04 · TC-NOTI-02 | TC-NOTI-02 (ดู §3.1) | – | 46 passed · 5 failed ✅ |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | 50 passed · 1 failed ✅ |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | 50 passed · 1 failed ✅ |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | 50 passed · 1 failed ✅ |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | 50 passed · 1 failed ✅ |
| B08 | TC-QUEUE-02 (ส่วน 3 ต่อกัน ล้มแน่นอน) | TC-QUEUE-02 | – | – | 50 passed · 1 failed ✅ |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | 50 passed · 1 failed ✅ |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – (ทั้งสองอยู่ในรายการ "อาจล้มด้วย") | – | 48 passed · 3 failed ✅ |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | 49 passed · 2 failed ✅ |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | 50 passed · 1 failed ✅ |

**สรุป: จับได้ 12/12** · TC ที่ควรล้มแต่ผ่าน = 0 · ทุกข้อล้มด้วย "ค่าจริง ≠ ค่าคาดหวัง" ไม่มีข้อไหนล้มเพราะหา element ไม่เจอ

## 2. ผล triage (รูปแบบ BUGS.md §6)

| บั๊ก | ผลรัน | สรุป |
|---|---|---|
| B01 | 50 passed · 1 failed: TC-FEE-01 `fee-total` expected `฿1,010` received `฿1,000` (พื้นที่ 101) | ✅ จับได้ตรงจุด |
| B02 | 50 passed · 1 failed: TC-UPLOAD-01 `size-5242880.pdf` (5,242,880 ไบต์) ต้องถูกรับ แต่ `file-item` expected 1 received 0 | ✅ จับได้ตรงจุดที่ขอบ ≤ 5 MB |
| B03 | 46 passed · 5 failed: TC-SLA-01 `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` · TC-SLA-02 `sla-due` expected `8 ธ.ค. 2569 16:30` received `7 ธ.ค. 2569 16:30` · TC-SLA-03 (ศ.4 ธ.ค. 09:00) `sla-level` expected `ใกล้ครบกำหนด` received `ปกติ` · TC-RBAC-04 `dueAt` expected `2026-12-08…` received `2026-12-04…` (วันหยุด 2 ธ.ค. ที่ admin เพิ่มไม่ถูกนับ) · TC-NOTI-02 ขาดแจ้งเตือน `EG-2569-000016\|near` | ✅ จับได้ · SLA-03 และ RBAC-04 เป็นผลข้างเคียงที่ BUGS.md ยอมรับ · NOTI-02 ล้มเกิน ดู §3.1 |
| B04 | 50 passed · 1 failed: TC-SLA-02 `sla-due` expected `8 ธ.ค. 2569 16:30` received `4 ธ.ค. 2569 16:30` (ไม่หยุดนับระหว่าง NEED_FIX) | ✅ จับได้ตรงจุด |
| B05 | 50 passed · 1 failed: TC-PAY-01 ชำระ `PP-0001` ที่ 09:10:00 (อายุ 15:00 พอดี) ได้ `200 PAID` เลข `EG-2569-000031` แทน `410 QR_EXPIRED` | ✅ จับได้ที่ขอบ < 15:00 |
| B06 | 50 passed · 1 failed: TC-RBAC-01 HTTP expected 404 received 200 (สมหญิงเปิดคำขอของสมชาย) | ✅ จับได้ IDOR |
| B07 | 50 passed · 1 failed: TC-RBAC-02 `POST /api/cases/EG-2569-000014/approve` → `{"status":"APPROVED"}` HTTP expected 403 received 200 | ✅ จับได้ เพราะ test ยิง API ตรง ไม่ได้ตรวจแค่ว่าปุ่มหาย |
| B08 | 50 passed · 1 failed: TC-QUEUE-02 `off.reg2` กดรับ `EG-2569-000028` ต้องได้ `มีเจ้าหน้าที่รับเรื่องนี้แล้ว` แต่ได้ข้อความรับเรื่องสำเร็จ | ✅ จับได้ (ล้มทุกครั้ง ไม่พึ่ง race จริง) |
| B09 | 50 passed · 1 failed: TC-PDPA-02 `GET /api/officer/queue?filter=all` ของ `off.reg1` พบ `\d{13}` ใน JSON | ✅ จับได้ที่ API (หน้าจอยังปิดบัง) |
| B10 | 48 passed · 3 failed: TC-DASH-01 `kpi-ontime-pct` expected `–` received `0.0%` · TC-DASH-02 expected `85.7%` received `23.1%` · TC-DASH-03 expected `85.7%` received `23.1%` | ✅ จับได้ ล้มเกินจาก 1 TC เพราะใช้สูตรเดียวกัน ตามที่ BUGS.md ยอมรับ |
| B11 | 49 passed · 2 failed: TC-PDPA-03 `audit-count` (กรอง UNMASK) expected `1` received `0` · TC-AUDIT-01 `audit-count` expected `16` received `15` | ✅ จับได้ทั้ง 2 TC ที่ระบุ |
| B12 | 50 passed · 1 failed: TC-WORKFLOW-04 `return-btn` (คำขอที่ตีกลับครบ 2 ครั้ง) expected count 0 received 1 | ✅ จับได้ |

## 3. ข้อที่ผลไม่ตรงที่คาด

### 3.1 B03 → TC-NOTI-02 ล้มเกินที่ BUGS.md ระบุ

| ตรวจ | ผล |
|---|---|
| อาการ | ชุดแจ้งเตือนตอน request แรกที่ ส. 5 ธ.ค. 2569 10:00 (TEST-DATA §8.1) ขาด `EG-2569-000016\|near` 1 รายการ รายการอื่นตรงทั้งหมด |
| สาเหตุ | `…000016` กำหนดเสร็จ อ. 8 ธ.ค. · ที่ ส. 5 ธ.ค. วันคงเหลือที่ถูกต้อง = 1 (จ. 7 เป็นวันหยุด) → `ใกล้ครบกำหนด` → ต้องแจ้งเตือน · B03 นับ จ. 7 เป็นวันทำการ → เหลือ 2 → `ปกติ` → ไม่แจ้งเตือน |
| เป็นบั๊กรั่วเกินจุดไหม | **ไม่ใช่** · เป็นกลไกเดียวกับ TC-SLA-03 ที่ BUGS.md ตาราง 2 ยอมรับไว้แล้ว ("ฟังก์ชันวันทำการตัวเดียวกันใช้นับวันคงเหลือข้าม 7 ธ.ค.") และเป็นคำขอใบเดียวกัน (`…000016`) · DECISIONS §18 กำหนดให้ใช้ฟังก์ชันวันทำการตัวเดียวทั้งระบบ · ข้อมูล seed (`dueAt`) ไม่ถูกแตะ (กติกาข้อ 2) |
| test พึ่งกันเองไหม | **ไม่ใช่** · TC-NOTI-02 เริ่มด้วย reset ของตัวเอง และผ่านในรอบปกติทุกรอบ |
| ประเภท | **แผนผิด (ตาราง BUGS.md ไม่ครบ)** · ไม่แก้เว็บและไม่แก้ test เอง |
| คำถามถึง TA | Q-BUG-01: B03 ทำให้ระดับเตือนของ `…000016` ที่ ส. 5 ธ.ค. เปลี่ยนจาก `ใกล้ครบกำหนด` เป็น `ปกติ` (กลไกเดียวกับ TC-SLA-03 ที่ยอมรับแล้ว) ทำให้ TC-NOTI-02 ล้มด้วย ควรเพิ่ม TC-NOTI-02 ในคอลัมน์ "TC ที่อาจล้มด้วย" ของ B03 หรือต้องการให้ B03 กระทบเฉพาะการคำนวณ `dueAt` (ซึ่งจะทำให้ TC-SLA-03 ไม่ล้มด้วย) |

### 3.2 บั๊กที่ TC ไม่ล้ม

ไม่มี · ทั้ง 12 บั๊ก TC ใน "TC ที่ต้องล้ม" ล้มจริงทุกตัว จึงไม่ต้องแก้เว็บ (ฝังบั๊กครบตาม BUGS.md) และไม่ต้องแก้ test (ไม่มีข้อที่ผ่านหลอก)

## 4. สิ่งที่แก้ก่อนเริ่ม (จากขั้นรัน TEST-PLAN)

| ไฟล์ | ประเภท | แก้อะไร |
|---|---|---|
| `app/server/db.js` | เว็บผิด | SQLite WAL ล้มด้วย SIGBUS (exit 135) เมื่อ `./data` เป็น bind mount จาก Windows → ค่าเริ่มต้นเป็น `journal_mode = DELETE` (ตั้ง `SQLITE_JOURNAL_MODE=WAL` ได้) |
| `app/tests/e2e/part-b.spec.ts` (TC-NFR-01) | test ผิด | รอ `wizard-step` = `2/3 แนบเอกสาร` ก่อนแนบไฟล์ (race) · ไม่แก้ค่าคาดหวัง |

## 5. รวมบั๊ก (BUGS.md §3 ขั้น 5–6)

| BUG_MODE | union ที่คาดจากรอบเดี่ยว | TC ที่ล้มจริง | ผลรัน | ตรง union |
|---|---|---|---|---|
| `B03,B07` | B03 (SLA-01 · SLA-02 · SLA-03 · NOTI-02 · RBAC-04) + B07 (RBAC-02) | TC-SLA-01 · TC-SLA-02 · TC-SLA-03 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | 45 passed · 6 failed | ✅ ไม่หาย ไม่เพิ่ม |
| `B01,B05,B09` | B01 (FEE-01) + B05 (PAY-01) + B09 (PDPA-02) | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | 48 passed · 3 failed | ✅ ไม่หาย ไม่เพิ่ม |
| (ปิดบั๊กทั้งหมด · ขั้น 6) | – | – | 51 passed | ✅ กลับมาผ่านครบ |

ผลดิบ: `bug-runs/B03,B07.json` · `bug-runs/B01,B05,B09.json` · `bug-runs/none.json`
