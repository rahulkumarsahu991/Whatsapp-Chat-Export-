# Cloud image: the exporter in "cloud mode" (one isolated WhatsApp session per visitor).
# Works on Hugging Face Spaces (Docker), Railway, Render, Koyeb or any VPS with Docker.
FROM node:22-bookworm-slim

# Chromium runs WhatsApp Web; Noto fonts render emoji and Indian scripts in names/messages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium fonts-noto-color-emoji fonts-noto-core ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CLOUD=1 \
    PORT=7860 \
    DATA_DIR=/data/whatsapp \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# Run as the unprivileged "node" user (uid 1000, which Hugging Face Spaces also expects).
RUN mkdir -p /data/whatsapp && chown -R node:node /data /app
USER node

EXPOSE 7860
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
