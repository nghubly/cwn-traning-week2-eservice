import { test } from '@playwright/test';

/**
 * อัดวิดีโอของ context ที่ helper สร้างเอง (browser.newContext ไม่ใช้ค่า `use.video` ของ config)
 * เปิดด้วย RECORD_VIDEO=1 เท่านั้น · ไฟล์อยู่ใน outputDir ของ test นั้น/videos (ใช้ทำ GIF หลักฐาน)
 * ไม่เปลี่ยนขั้นตอนหรือค่าคาดหวังของ test
 */
export function recordVideoOpts(): { recordVideo?: { dir: string; size: { width: number; height: number } } } {
  if (!process.env.RECORD_VIDEO) return {};
  return { recordVideo: { dir: test.info().outputPath('videos'), size: { width: 1280, height: 720 } } };
}
