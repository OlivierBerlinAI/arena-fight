# syntax=docker/dockerfile:1

# --- build the static client with Vite ----------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/client/package.json packages/client/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/client ./packages/client
RUN npm run build -w @mech-arena-fight/client

# --- serve the build with an unprivileged nginx (listens on 8080, runs as 101)-
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY packages/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/client/dist /usr/share/nginx/html
EXPOSE 8080
