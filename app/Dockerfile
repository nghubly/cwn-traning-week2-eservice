# e-Service กลาง เทศบาลนครสุขใจ (สมมติ) · Node 20 + Express + SQLite
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# เครื่องมือ build สำรอง เผื่อ better-sqlite3 ไม่มี prebuilt สำหรับแพลตฟอร์มนี้
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 TZ=Asia/Bangkok
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
