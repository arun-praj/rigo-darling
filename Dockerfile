FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    RIGOHR_DB_PATH=/app/data/rigohr.sqlite

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

RUN mkdir -p /app/data /app/.browser-profile \
    && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 4317

CMD ["node", "dist/server.js"]
