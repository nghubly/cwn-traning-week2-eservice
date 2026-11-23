-- e-Service กลาง เทศบาลนครสุขใจ (สมมติ) · SQLite schema
-- กติกาทุกตาราง:
--   * เวลา = TEXT ISO "+07:00" จาก clock.toIso() (ห้ามเก็บ epoch ms: 13 หลักชนการตรวจ PDPA)
--   * เลขบัตร/เบอร์/อีเมล = เก็บเข้ารหัส (pii.encrypt) ในคอลัมน์ *_enc + ค่าค้นหา pii.lookupHash ใน *_hash
--   * ผู้ใช้เจ้าหน้าที่อ้างด้วย username (TEXT) เพื่อให้ JSON/seed ตรง CONTRACT
--   * เงิน = INTEGER บาท

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ผู้ใช้ทุกบทบาท · citizen ใช้ id_no_hash ล็อกอิน · staff ใช้ username/password_hash
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE,                 -- staff: off.reg1 · citizen: NULL (หรือรหัสภายใน เช่น cit-1)
  password_hash TEXT,                        -- lib/password.js
  name          TEXT NOT NULL DEFAULT '',     -- ชื่อแสดง (user-name)
  role          TEXT NOT NULL CHECK (role IN ('citizen','officer','head','executive','auditor','admin')),
  dept          TEXT NOT NULL DEFAULT '',     -- officer: registry | works · อื่น ๆ ''
  id_no_enc     TEXT,                        -- citizen: เลขบัตร 13 หลัก (AES-256-GCM)
  id_no_hash    TEXT UNIQUE,                 -- citizen: pii.lookupHash(เลขบัตร)
  id_masked     TEXT,                        -- X-XXXX-XXXXX-45-6
  mobile_enc    TEXT,                        -- เบอร์ 10 หลัก (เข้ารหัส)
  email_enc     TEXT,                        -- อีเมล (เข้ารหัส · ว่างได้)
  registered    INTEGER NOT NULL DEFAULT 1,  -- citizen ยังไม่ลงทะเบียน = 0
  consent_at    TEXT,                        -- เวลายินยอม PDPA
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_role ON users(role, dept);

-- session cookie (HttpOnly) · reset ล้างทั้งตาราง → cookie เก่าใช้ไม่ได้
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,               -- base64url สุ่ม
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL DEFAULT 'full',    -- full | register (citizen ยังไม่ลงทะเบียน ใช้ได้เฉพาะ /register)
  data       TEXT NOT NULL DEFAULT '{}',      -- JSON (ห้ามใส่เลขบัตร/เบอร์ตรง ๆ)
  created_at TEXT
);

-- ตัวนับ OTP ผิด / การล็อก (BR-02) ต่อเลขบัตร (อ้างด้วย lookupHash)
CREATE TABLE IF NOT EXISTS otp_attempts (
  id_no_hash   TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  otp_sent_at  TEXT,
  updated_at   TEXT
);

-- แคตตาล็อกบริการ (admin แก้ fee/sla ได้)
CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,               -- SV-01 SV-02 SV-03
  name        TEXT NOT NULL,                  -- ขอหนังสือรับรอง ...
  fee         INTEGER,                        -- SV-01 ต่อฉบับ (20) · SV-02 เหมาจ่าย (500) · SV-03 NULL
  fee_base    INTEGER,                        -- SV-03 1000
  fee_per_sqm INTEGER,                        -- SV-03 10
  sla         INTEGER NOT NULL,               -- วันทำการ 3 / 10 / 15
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT
);

-- เอกสารที่บริการต้องใช้ (CONTRACT 4.3)
CREATE TABLE IF NOT EXISTS service_docs (
  service_id TEXT NOT NULL REFERENCES services(id),
  doc_key    TEXT NOT NULL,                   -- id-card map site-photo plan deed
  label      TEXT NOT NULL,                   -- บัตรประชาชน แผนที่ตั้ง ภาพสถานที่ แบบแปลน โฉนด
  required   INTEGER NOT NULL DEFAULT 1,
  pdf_only   INTEGER NOT NULL DEFAULT 0,      -- แบบแปลน = 1
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, doc_key)
);

CREATE TABLE IF NOT EXISTS holidays (
  date       TEXT PRIMARY KEY,                -- YYYY-MM-DD (เวลาไทย)
  name       TEXT NOT NULL,
  created_at TEXT
);

-- ตัวนับเลขรัน: case:2569 receipt:2569 doc:2569 draft payment
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- ร่างคำขอ (ก่อนมีเลขคำขอ) · DR-0001
CREATE TABLE IF NOT EXISTS drafts (
  id         TEXT PRIMARY KEY,                -- DR-0003
  user_id    INTEGER NOT NULL REFERENCES users(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  status     TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_PAYMENT','SUBMITTED','DELETED')),
  qty        INTEGER,                         -- SV-01
  area_sqm   INTEGER,                         -- SV-03
  fee        INTEGER NOT NULL DEFAULT 0,      -- ค่าธรรมเนียมที่คำนวณล่าสุด
  fee_locked INTEGER,                         -- ยอดที่ล็อกตอนเข้า PENDING_PAYMENT (A-42)
  locked_at  TEXT,
  case_no    TEXT,                            -- หลังชำระสำเร็จ
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_drafts_user ON drafts(user_id, status);

-- คำขอที่มีเลขแล้ว · EG-2569-000031
CREATE TABLE IF NOT EXISTS cases (
  case_no       TEXT PRIMARY KEY,
  year_be       INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  draft_id      TEXT REFERENCES drafts(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),   -- ผู้ยื่น
  service_id    TEXT NOT NULL REFERENCES services(id),
  qty           INTEGER,
  area_sqm      INTEGER,
  fee           INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('SUBMITTED','IN_REVIEW','NEED_FIX','PENDING_APPROVAL','APPROVED','COMPLETED','REJECTED','CANCELLED')),
  dept          TEXT,                         -- แผนกที่ถือเรื่องตอนนี้: registry | works | head | NULL (ปิดแล้ว)
  step          INTEGER,                      -- SV-03 เท่านั้น 1–3 · อื่น ๆ NULL
  owner         TEXT,                         -- username ผู้ถือเรื่อง (NULL = ยังไม่มีผู้รับ)
  issuer        TEXT,                         -- username ผู้ออกเอกสาร (A-27: ทะเบียนที่รับขั้นแรก)
  registry_officer TEXT,                      -- ผู้รับขั้นทะเบียน (SV-03)
  works_officer    TEXT,                      -- ผู้รับขั้นโยธา (SV-03)
  return_count  INTEGER NOT NULL DEFAULT 0,
  paid_at       TEXT,
  due_at        TEXT,                         -- กำหนดเสร็จ (ISO +07:00)
  need_fix_at   TEXT,                         -- เวลาตีกลับล่าสุด
  fix_deadline  TEXT,                         -- need_fix_at + 168 ชม.
  approved_by   TEXT,
  approved_at   TEXT,
  closed_at     TEXT,                         -- COMPLETED/REJECTED
  cancelled_at  TEXT,
  cancel_reason TEXT,                         -- citizen | auto-fix-expired
  receipt_no    TEXT,
  payment_ref   TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  UNIQUE (year_be, seq)
);
CREATE INDEX IF NOT EXISTS ix_cases_user ON cases(user_id);
CREATE INDEX IF NOT EXISTS ix_cases_queue ON cases(dept, status, due_at, case_no);
CREATE INDEX IF NOT EXISTS ix_cases_owner ON cases(owner, status);

-- ประวัติตีกลับ (TEST-DATA 4.4) · paused_days = วันทำการที่หยุดนับ
CREATE TABLE IF NOT EXISTS case_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no        TEXT NOT NULL REFERENCES cases(case_no),
  n              INTEGER NOT NULL,            -- ครั้งที่ 1, 2
  returned_at    TEXT NOT NULL,
  returned_by    TEXT,
  reason         TEXT NOT NULL,
  resubmitted_at TEXT,
  paused_days    INTEGER,
  UNIQUE (case_no, n)
);

-- ไทม์ไลน์ที่แสดงในหน้าคำขอ (timeline-item)
CREATE TABLE IF NOT EXISTS case_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no     TEXT NOT NULL REFERENCES cases(case_no),
  time        TEXT NOT NULL,
  actor       TEXT,                           -- username หรือ 'citizen' / 'system'
  event       TEXT NOT NULL,                  -- SUBMIT CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL AUTO_CANCEL
  from_status TEXT,
  to_status   TEXT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS ix_case_events ON case_events(case_no, time);

-- ไฟล์แนบ · เนื้อไฟล์อยู่บนดิสก์ที่ UPLOAD_DIR/<storage_name> (ไม่เก็บใน DB)
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,              -- รหัสสุ่ม base64url
  draft_id     TEXT REFERENCES drafts(id),
  case_no      TEXT REFERENCES cases(case_no),
  doc_key      TEXT NOT NULL,
  name         TEXT NOT NULL,                 -- ชื่อไฟล์เดิม
  mime         TEXT NOT NULL,                 -- จาก magic bytes
  size         INTEGER NOT NULL,
  storage_name TEXT NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  is_seed      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_files_draft ON files(draft_id);
CREATE INDEX IF NOT EXISTS ix_files_case ON files(case_no);

-- QR ชำระเงินจำลอง · PP-0001
CREATE TABLE IF NOT EXISTS payments (
  ref           TEXT PRIMARY KEY,
  draft_id      TEXT NOT NULL REFERENCES drafts(id),
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','VOID')),  -- EXPIRED คำนวณจากนาฬิกา
  qr_created_at TEXT NOT NULL,
  qr_expires_at TEXT NOT NULL,
  paid_at       TEXT,
  case_no       TEXT,
  receipt_no    TEXT
);
CREATE INDEX IF NOT EXISTS ix_payments_draft ON payments(draft_id);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_no  TEXT PRIMARY KEY,               -- RC-2569-000031
  case_no     TEXT NOT NULL UNIQUE REFERENCES cases(case_no),
  payment_ref TEXT,
  amount      INTEGER NOT NULL,
  issued_at   TEXT NOT NULL
);

-- เอกสารดิจิทัล · ลายเซ็น HMAC-SHA256 (base64url) ของ payload
CREATE TABLE IF NOT EXISTS documents (
  doc_no      TEXT PRIMARY KEY,               -- DOC-2569-000001
  case_no     TEXT NOT NULL UNIQUE REFERENCES cases(case_no),
  verify_code TEXT NOT NULL UNIQUE,           -- [A-Z0-9]{8}
  service_id  TEXT NOT NULL,
  applicant_masked TEXT,                      -- สมชาย ใ***
  issued_at   TEXT NOT NULL,
  valid_until TEXT NOT NULL,                  -- YYYY-MM-DD (ใช้ได้ถึงสิ้นวันนั้น)
  signer      TEXT NOT NULL,                  -- ชื่อแสดงผู้ลงนาม
  signer_username TEXT,
  payload     TEXT NOT NULL,                  -- JSON ที่ลงนาม (ห้ามมีเลขบัตร/เบอร์)
  signature   TEXT NOT NULL
);

-- แจ้งเตือนในกระดิ่ง · 1 ครั้งต่อระดับต่อคำขอต่อคน
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  case_no    TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('near','overdue')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT,
  UNIQUE (username, case_no, level)
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(username, created_at);

-- Audit Trail (append-only: trigger ห้าม UPDATE/DELETE · reset ใช้ DROP TABLE)
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  time        TEXT NOT NULL,                  -- ISO +07:00
  username    TEXT,
  role        TEXT,
  event       TEXT NOT NULL,                  -- STAFF_LOGIN CLAIM RETURN FORWARD APPROVE REJECT ISSUE UNMASK EXPORT ADMIN_CHANGE ...
  case_no     TEXT,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_audit_time ON audit_log(time);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
