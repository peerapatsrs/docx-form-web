/**
 * Preferred local/dev account for Run Local auto sign-in.
 * Order: DEV_AUTH_DEFAULT_EMAIL → first SUPERADMIN_EMAILS.
 * Returns undefined when neither is configured (callers must fail gracefully).
 *
 * Plain module (no `server-only`) so CLI migrate / instrumentation can import
 * auth → dev-auth-plugin without the react-server condition.
 */
export function getDefaultDevAuthEmail(): string | undefined {
  const fromEnv = String(process.env.DEV_AUTH_DEFAULT_EMAIL || "")
    .trim()
    .toLowerCase();
  if (fromEnv) return fromEnv;
  const superadmin = String(process.env.SUPERADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .find(Boolean);
  return superadmin || undefined;
}
