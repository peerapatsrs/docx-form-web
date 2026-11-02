# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Public origin build-args. Render maps service env vars → Docker build-args.
# BETTER_AUTH_URL must come from env (or the same public base URL) — never a
# hardcoded host. Nested ${...:-${...}} in ENV is unreliable in Docker builders,
# so resolution happens in shell before `next build`.
ARG APP_BASE_URL=
ARG NEXT_PUBLIC_APP_URL=
ARG BETTER_AUTH_URL=
ENV APP_BASE_URL=$APP_BASE_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
# Placeholder secret so `next build` can import auth modules (not a real secret).
ENV BETTER_AUTH_SECRET=build-time-placeholder-secret-32chars
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
# Render Docker builds use the Starter pipeline (~8GB). Cap heap for smaller builders.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN ba="${BETTER_AUTH_URL:-}"; \
    if [ -z "$ba" ]; then ba="${NEXT_PUBLIC_APP_URL:-}"; fi; \
    if [ -z "$ba" ]; then ba="${APP_BASE_URL:-}"; fi; \
    if [ -n "$ba" ]; then export BETTER_AUTH_URL="$ba"; fi; \
    if [ -z "${NEXT_PUBLIC_APP_URL:-}" ] && [ -n "$ba" ]; then \
      export NEXT_PUBLIC_APP_URL="$ba"; \
    fi; \
    npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV HOME=/tmp
ENV DOCX_FORM_CONFIG_DIR=/tmp/docx-form
# Free web plan is 512MB RAM — keep Node heap below that for native overhead.
ENV NODE_OPTIONS=--max-old-space-size=384
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --home /tmp nextjs \
  && mkdir -p /tmp/docx-form \
  && chown -R nextjs:nodejs /tmp/docx-form
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
