/**
 * Single source for Better Auth signing secret resolution.
 * Production must set BETTER_AUTH_SECRET (or AUTH_SECRET) — no silent fallback.
 */

/** Dev / test / build-placeholder only — never rely on this in real prod. */
export const DEV_AUTH_SECRET_FALLBACK =
  "docx-form-dev-secret-change-me-32b";

export type BetterAuthSecretHealth = {
  /** False when production is missing a configured secret. */
  ready: boolean;
  /** Whether BETTER_AUTH_SECRET or AUTH_SECRET is set. */
  configured: boolean;
};

/**
 * Readiness for the auth signing secret (used by /api/health + startup).
 */
export function getBetterAuthSecretHealth(
  envSource: NodeJS.ProcessEnv = process.env,
): BetterAuthSecretHealth {
  const configured = Boolean(
    String(envSource.BETTER_AUTH_SECRET || envSource.AUTH_SECRET || "").trim(),
  );
  if (configured) return { ready: true, configured: true };
  const isProd = String(envSource.NODE_ENV || "").trim() === "production";
  return { ready: !isProd, configured: false };
}

/**
 * Startup check — logs when production is missing BETTER_AUTH_SECRET.
 * Does not throw (health reports not-ready); resolveBetterAuthSecret still
 * fails fast when the secret is actually needed in production.
 */
export function checkBetterAuthSecretAtStartup(
  envSource: NodeJS.ProcessEnv = process.env,
): BetterAuthSecretHealth {
  const health = getBetterAuthSecretHealth(envSource);
  if (!health.ready) {
    console.error(
      "[auth] BETTER_AUTH_SECRET (or AUTH_SECRET) is required in production — not ready",
    );
  } else if (!health.configured) {
    console.warn(
      "[auth] BETTER_AUTH_SECRET unset; using dev fallback (not for production)",
    );
  }
  return health;
}

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
