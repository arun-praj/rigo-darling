FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    RIGOHR_DB_PATH=/app/data/rigohr.sqlite

COPY package*.json ./
RUN npm config set fund false \
    && npm config set audit false \
    && npm config set update-notifier false \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

RUN mkdir -p /app/data /app/.browser-profile \
    && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 4317

CMD ["node", "dist/server.js"]
