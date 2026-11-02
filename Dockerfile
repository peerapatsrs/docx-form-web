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
# Build-time public origin + optional dev-auth client flag.
# Placed above the auth placeholders so the `RUN npm run build` line stays
# identical to main and parallel PRs can switch it to `build:prod` cleanly.
ARG APP_BASE_URL=
ARG NEXT_PUBLIC_APP_URL=
ARG NEXT_PUBLIC_DEV_AUTH=
ENV APP_BASE_URL=$APP_BASE_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_DEV_AUTH=$NEXT_PUBLIC_DEV_AUTH
# Placeholder secrets so `next build` can import auth modules.
# Prefer an explicit public origin when provided so static fallbacks are not localhost.
ARG BETTER_AUTH_URL=
ENV BETTER_AUTH_SECRET=build-time-placeholder-secret-32chars
ENV BETTER_AUTH_URL=${BETTER_AUTH_URL:-${NEXT_PUBLIC_APP_URL:-${APP_BASE_URL:-http://localhost:3000}}}
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
# Minify static /public client assets, then build the Next standalone output.
RUN npm run build:prod

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV HOME=/tmp
ENV DOCX_FORM_CONFIG_DIR=/tmp/docx-form
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
