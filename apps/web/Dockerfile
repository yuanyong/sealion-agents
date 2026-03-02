# ─── Stage 1: Install & Build ────────────────────────────────────────
FROM oven/bun:1.1 AS builder

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./

# Copy all workspace packages (needed for workspace:* resolution)
COPY packages/ packages/
COPY apps/web/ apps/web/
# Electron renderer source is shared via Vite alias
COPY apps/electron/src/renderer/ apps/electron/src/renderer/
# Themes referenced by web server
COPY apps/electron/resources/ apps/electron/resources/

# Install dependencies
RUN bun install --frozen-lockfile

# Build client (Vite) + server (Bun)
WORKDIR /app/apps/web
RUN bun run build

# ─── Stage 2: Production Runtime ─────────────────────────────────────
FROM oven/bun:1.1-slim AS runtime

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/apps/web/dist/ ./dist/

# Copy server source (Bun runs .ts directly, faster than bundled JS for monorepo)
COPY --from=builder /app/apps/web/src/server/ ./src/server/

# Copy workspace packages (needed at runtime by server imports)
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/package.json ./package.json

# Copy web package.json for metadata
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3001/api/sandbox/info').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "src/server/index.ts"]
