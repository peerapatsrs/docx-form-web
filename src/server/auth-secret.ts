/**
 * Single source for Better Auth signing secret resolution.
 * Production must set BETTER_AUTH_SECRET (or AUTH_SECRET) — no silent fallback.
 */

/** Dev / test / build-placeholder only — never rely on this in real prod. */
export const DEV_AUTH_SECRET_FALLBACK =
  "docx-form-dev-secret-change-me-32b";

/**
 * Resolve the Better Auth cookie/session signing secret.
 * @throws if NODE_ENV=production and no secret is configured
 */
export function resolveBetterAuthSecret(
  envSource: NodeJS.ProcessEnv = process.env,
): string {
  const secret = String(
    envSource.BETTER_AUTH_SECRET || envSource.AUTH_SECRET || "",
  ).trim();
  if (secret) return secret;
  if (String(envSource.NODE_ENV || "").trim() === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET (or AUTH_SECRET) is required in production",
    );
  }
  return DEV_AUTH_SECRET_FALLBACK;
}
