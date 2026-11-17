/**
 * Single source for Better Auth signing secret resolution.
 * Production must set BETTER_AUTH_SECRET (or AUTH_SECRET) — no silent fallback.
 * Non-production generates a cryptographically random secret per process.
 */

import { randomBytes } from "node:crypto";

/** Cached ephemeral secret for this process (dev / test only). */
let ephemeralDevSecret: string | undefined;

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

function getEphemeralDevSecret(): string {
  if (!ephemeralDevSecret) {
    ephemeralDevSecret = randomBytes(32).toString("base64url");
    console.warn(
      "[auth] BETTER_AUTH_SECRET unset; generated ephemeral per-process secret (not for production)",
    );
  }
  return ephemeralDevSecret;
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
    // Ensure the ephemeral secret exists and the warn fires once at startup.
    getEphemeralDevSecret();
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
  return getEphemeralDevSecret();
}
