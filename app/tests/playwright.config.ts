import { defineConfig, devices } from '@playwright/test';

/**
 * BASE_URL มาจากตัวแปรสภาพแวดล้อม (TEST-PLAN §0) · ค่าเริ่มต้น http://localhost:3000
 * ทุก TC เรียก POST /api/test/reset ซึ่งล้างสถานะทั้งเซิร์ฟเวอร์ → ต้องรันทีละ test (workers: 1)
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: BASE_URL } }],
});
