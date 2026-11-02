/**
 * Whether development-only auth helpers are active.
 * Auto-on outside production; override with DEV_AUTH=0|1.
 * Client builds may also gate UI via NEXT_PUBLIC_DEV_AUTH at build time.
 */
export function isDevAuthEnabled(): boolean {
  const explicit = String(process.env.DEV_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "no") {
    return false;
  }
  if (explicit === "1" || explicit === "true" || explicit === "yes") {
    return true;
  }
  return process.env.NODE_ENV !== "production";
}

/**
 * Build-time flag for including dev-auth client UI in the bundle.
 * Production images should leave this unset so the picker code is dropped.
 */
export function isDevAuthClientIncluded(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const flag = String(process.env.NEXT_PUBLIC_DEV_AUTH ?? "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}
