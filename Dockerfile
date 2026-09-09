FROM node:22-trixie AS build

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm install --ignore-scripts --no-package-lock --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-trixie AS runtime

RUN apt-get update \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=60 \
    -o Acquire::https::Timeout=60 \
    && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    BROWSER_HEADLESS=false \
    DISPLAY=:99 \
    RIGOHR_DB_PATH=/app/data/rigohr.sqlite \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY docker ./docker

RUN mkdir -p /app/data /app/.browser-profile \
    && useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app

USER appuser
EXPOSE 4317 6080

CMD ["sh", "/app/docker/entrypoint.sh"]
