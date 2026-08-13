FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    RIGOHR_DB_PATH=/app/data/rigohr.sqlite \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev

RUN mkdir -p /app/data /app/.browser-profile \
    && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 4317

CMD ["node", "dist/server.js"]
