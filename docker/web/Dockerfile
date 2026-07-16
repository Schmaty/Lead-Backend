# syntax=docker/dockerfile:1

# ── Build the dashboard ───────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
RUN npx vite build

# ── Serve static files + proxy /api to the api service ───────────────────────
FROM nginx:1.27-alpine
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
