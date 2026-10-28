# API + worker image (same image; the command decides the role).
# Build from the repository root:  docker build -f backend/Dockerfile -t flashsale-api .
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# Production dependencies of the backend workspace only (hoisted to /app/node_modules).
RUN npm ci --workspace backend --omit=dev --no-audit --no-fund

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json ./backend/
COPY backend/src ./backend/src
COPY backend/scripts ./backend/scripts
WORKDIR /app/backend
# Never run as root inside the container.
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:4000/api/health/ready || exit 1
CMD ["node", "src/server.js"]
