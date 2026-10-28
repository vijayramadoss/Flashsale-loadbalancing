# Storefront + load balancer image: builds the React app, then serves it from
# NGINX, which also balances /api across the API replicas.
# Build from the repository root:  docker build -f frontend/Dockerfile -t flashsale-web .
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --no-audit --no-fund
COPY frontend ./frontend
# vite build → precompress (.gz/.br) → bundle budget gate (fails the build if > 200 KB)
RUN npm run build --workspace frontend

FROM nginx:1.28-alpine
COPY infra/docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
