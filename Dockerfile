FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/class-study.sqlite
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
RUN mkdir -p /app/data \
    && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]

FROM node:24-alpine AS backup
RUN apk add --no-cache sqlite tzdata
COPY scripts/monthly-backup.sh /usr/local/bin/monthly-backup.sh
RUN chmod 0755 /usr/local/bin/monthly-backup.sh \
    && printf '%s\n' '0 3 1 * * /usr/local/bin/monthly-backup.sh' > /etc/crontabs/root
CMD ["/bin/sh", "-c", "/usr/local/bin/monthly-backup.sh && exec crond -f -l 2"]
