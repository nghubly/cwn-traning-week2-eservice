#!/bin/bash
# แปลงวิดีโอ P1 → GIF (รันในคอนเทนเนอร์ชั่วคราวที่ mount test-report ไว้ที่ /w)
# ใช้: docker run --rm -v "<test-report>:/w" ubuntu:24.04 bash /w/make-gifs.sh
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq ffmpeg >/dev/null
cd /w
n=0
while IFS='|' read -r src dst; do
  [ -z "$src" ] && continue
  ffmpeg -nostdin -loglevel error -y -i "$src" \
    -vf "fps=5,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
    "$dst"
  n=$((n+1))
done < gif-list.txt
echo "gifs=$n"
