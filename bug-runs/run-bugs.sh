#!/bin/bash
# รันชุด Playwright เต็มทีละ BUG_MODE (BUGS.md §3 ขั้น 3) · ผลแต่ละรอบ → bug-runs/<รหัส>.json
# ใช้: bash bug-runs/run-bugs.sh [B01 B02 ...]   (ไม่ใส่ = B01..B12 แล้วปิดท้ายด้วยรอบปกติ none)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
OUT="$ROOT/bug-runs"
BUGS=("$@")
[ ${#BUGS[@]} -eq 0 ] && BUGS=(B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 none)

# เว็บตัวที่ 2 ไม่เปิด TEST_MODE สำหรับ TC-NFR-03 (ไม่ขึ้นกับ BUG_MODE)
docker rm -f egov-notest >/dev/null 2>&1
docker run -d --name egov-notest -p 3001:3000 -e TZ=Asia/Bangkok -e DB_PATH=/tmp/egov.db egov-eservice:latest >/dev/null

for B in "${BUGS[@]}"; do
  MODE="$B"; [ "$B" = "none" ] && MODE=""
  ( cd "$APP" && TEST_MODE=1 BUG_MODE="$MODE" docker compose up -d --force-recreate >/dev/null 2>&1 )
  ok=0
  for i in $(seq 1 60); do curl -sf http://localhost:3000/api/health >/dev/null && { ok=1; break; }; sleep 2; done
  if [ $ok -ne 1 ]; then echo "ROUND $B: web did not become healthy"; continue; fi
  start=$(date +%s)
  ( cd "$APP/tests" && PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/$B.json" BASE_URL=http://localhost:3000 BASE_URL_NO_TEST_MODE=http://localhost:3001 \
      HOST_DB_PATH="$APP/data/egov.db" npx playwright test --reporter=json >/dev/null 2>"$OUT/$B.stderr.log" )
  echo "ROUND $B done in $(( $(date +%s) - start ))s: $(node "$OUT/summarize.js" "$OUT/$B.json" --short)"
done

docker rm -f egov-notest >/dev/null 2>&1
( cd "$APP" && TEST_MODE=1 BUG_MODE= docker compose up -d --force-recreate >/dev/null 2>&1 )
echo "ALL ROUNDS DONE"
