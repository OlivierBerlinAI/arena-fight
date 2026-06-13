# syntax=docker/dockerfile:1

# --- install production dependencies against the workspace lockfile -----------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/client/package.json packages/client/package.json
RUN npm ci --omit=dev --ignore-scripts

# --- runtime ------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp
WORKDIR /app

# The server runs straight from TypeScript via tsx (same as `npm start`); tsx
# is a build-time dev tool, installed globally so the prod image stays slim.
RUN npm install -g tsx@4.19.2

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Drop privileges: the bundled `node` user owns nothing and can't write the FS.
USER node
EXPOSE 8080
CMD ["tsx", "packages/server/src/index.ts"]
