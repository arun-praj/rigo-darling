FROM node:22-trixie

RUN apt-get update \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=60 \
    -o Acquire::https::Timeout=60 \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    RIGOHR_DB_PATH=/app/data/rigohr.sqlite \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm install --ignore-scripts --no-package-lock

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev

RUN mkdir -p /app/data /app/.browser-profile \
    && useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app

USER appuser
EXPOSE 4317

CMD ["node", "dist/server.js"]
