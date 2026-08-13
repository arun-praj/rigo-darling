FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    RIGOHR_DB_PATH=/app/data/rigohr.sqlite

COPY package*.json ./
RUN npm install --global npm@10.9.2 --no-audit --no-fund \
    && npm config set registry https://registry.npmjs.org/ \
    && npm config set maxsockets 1 \
    && npm config set fund false \
    && npm config set audit false \
    && npm config set update-notifier false \
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
