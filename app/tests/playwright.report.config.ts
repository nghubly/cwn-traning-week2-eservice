import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * ใช้เก็บหลักฐานการรันชุดเต็ม (ไม่แก้ test และไม่แก้ค่าคาดหวัง)
 * ผลอยู่ที่ ../../test-report/ : results.json · index.html · วิดีโอทุก TC (แปลงเป็น GIF ภายหลัง)
 * รัน: npx playwright test -c playwright.report.config.ts
 */
const REPORT_DIR = process.env.REPORT_DIR || '../../test-report';

export default defineConfig({
  ...base,
  outputDir: `${REPORT_DIR}/artifacts`,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${REPORT_DIR}/html` }],
    ['json', { outputFile: `${REPORT_DIR}/results.json` }],
  ],
  use: {
    ...base.use,
    video: { mode: 'on', size: { width: 1280, height: 720 } },
  },
});
