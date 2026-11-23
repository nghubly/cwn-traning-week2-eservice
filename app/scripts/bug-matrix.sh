#!/usr/bin/env bash
# รันชุด Playwright เต็ม (51 TC) กับเว็บที่เปิดด้วย docker compose ทีละ BUG_MODE (BUGS.md §3)
#
# ใช้:   scripts/bug-matrix.sh                     # ปกติ ×2 + B01..B12 + ชุดรวม 2 ชุด + ปกติอีกรอบ
#        scripts/bug-matrix.sh "" B03 "B03,B07"    # ระบุโหมดเอง ("" = ไม่ตั้ง BUG_MODE)
# ผล:    $OUT/<mode>.json (Playwright JSON) + $OUT/<mode>.txt (list reporter) · สรุปด้วย scripts/summarize-results.js
# env:   OUT (ค่าเริ่มต้น test-results/matrix) · PLAYWRIGHT_BROWSERS_PATH · DOCKER_CONFIG (ถ้า credsStore ของเครื่องใช้ไม่ได้)
#        NOTEST_PORT (ค่าเริ่มต้น 3001) = เว็บอีกตัวที่ไม่ตั้ง TEST_MODE (DB แยก) ไว้ตรวจ TC-NFR-03 ว่า /api/test/* = 404
set -u
cd "$(dirname "$0")/.."
APP="$PWD"
OUT="${OUT:-$APP/tests/test-results/matrix}"
NOTEST_PORT="${NOTEST_PORT:-3001}"
mkdir -p "$OUT"

if [ "$#" -gt 0 ]; then MODES=("$@"); else
  MODES=("" "" B01 B02 B03 B04 B05 B06 B07 B08 B09 B10 B11 B12 "B03,B07" "B01,B05,B09" "")
fi

# เว็บตัวที่ 2: ไม่ตั้ง TEST_MODE · DB แยก (ไม่แตะ ./data ของตัวหลัก)
NOTEST_DIR="$(mktemp -d /tmp/egov-notest.XXXXXX)"
docker rm -f egov-notest >/dev/null 2>&1
docker run -d --name egov-notest -p "$NOTEST_PORT:3000" -e DB_PATH=/data/egov.db -e UPLOAD_DIR=/data/uploads \
  -v "$NOTEST_DIR:/data" egov-eservice:latest >/dev/null || echo "WARN: เปิดเว็บ no-TEST_MODE ไม่ได้"

wait_health() {
  for _ in $(seq 1 60); do
    curl -fs -m 2 "http://localhost:3000/api/health" >/dev/null && return 0
    sleep 1
  done
  return 1
}

i=0
for mode in "${MODES[@]}"; do
  i=$((i + 1))
  tag="${mode:-none}"; tag="${tag//,/+}"
  name="$(printf '%02d' "$i")-$tag"
  echo "=== [$name] TEST_MODE=1 BUG_MODE=$mode"
  # restart เฉพาะเมื่อ BUG_MODE เปลี่ยน (รอบ "ปกติ" ครั้งที่ 2 ต่อจากครั้งแรกโดยไม่ restart = BUGS.md §3 ขั้น 2)
  if [ "${prev-__unset__}" != "$mode" ]; then
    TEST_MODE=1 BUG_MODE="$mode" docker compose up -d --force-recreate >/dev/null 2>&1 || { echo "compose up ล้ม"; continue; }
  fi
  prev="$mode"
  wait_health || { echo "health ไม่ขึ้น"; docker compose logs --tail 30; continue; }
  docker compose logs --tail 3 web 2>/dev/null | grep -a "BUG_MODE" | tail -1
  curl -s "http://localhost:3000/api/test/info"; echo
  ( cd tests && BASE_URL=http://localhost:3000 BASE_URL_NO_TEST_MODE="http://localhost:$NOTEST_PORT" \
      PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT/$name.json" \
      npx playwright test --reporter=list,json --output="$OUT/$name-artifacts" > "$OUT/$name.txt" 2>&1 )
  tail -n 4 "$OUT/$name.txt" | sed 's/^/    /'
done

docker rm -f egov-notest >/dev/null 2>&1
echo "เสร็จ · ผลอยู่ที่ $OUT"
