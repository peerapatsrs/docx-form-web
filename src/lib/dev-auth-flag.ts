/**
 * Whether development-only auth helpers are active.
 *
 * Production (`NODE_ENV=production`): always off — even when DEV_AUTH=1 or
 * NEXT_PUBLIC_DEV_AUTH=1 (production-like deploys must use real OAuth/passkey).
 *
 * Non-production: on when DEV_AUTH is not explicitly 0 (unset defaults to on
 * for local DX). Override with DEV_AUTH=0|1.
 */
export function isDevAuthEnabled(): boolean {
  const explicit = String(process.env.DEV_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "no") {
    return false;
  }
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  if (explicit === "1" || explicit === "true" || explicit === "yes") {
    return true;
  }
  return true;
}

/**
 * Build-time flag for including dev-auth client UI in the bundle.
 * Never included in production builds regardless of NEXT_PUBLIC_DEV_AUTH.
 */
export function isDevAuthClientIncluded(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  const flag = String(process.env.NEXT_PUBLIC_DEV_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") {
    return false;
  }
  if (flag === "1" || flag === "true" || flag === "yes") {
    return true;
  }
  return true;
}
