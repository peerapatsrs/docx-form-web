/**
 * Explicit deployment-tier gate for DEV-only features.
 * Prefer APP_ENV over NODE_ENV — production builds can still run with APP_ENV=dev
 * locally, and SIT/UAT/PROD must never enable test-account seeding or exposure.
 */

export type AppEnvName = "dev" | "sit" | "uat" | "prod" | "production" | string;

export function getAppEnv(): string {
  return String(process.env.APP_ENV || "")
    .trim()
    .toLowerCase();
}

/** Hard allow for DEV-only test users / accounts. */
export function isAppEnvDev(): boolean {
  return getAppEnv() === "dev";
}

/** Known non-dev host tiers (SIT / UAT / PROD). */
export function isAppEnvNonDevHost(): boolean {
  const env = getAppEnv();
  return (
    env === "sit" ||
    env === "uat" ||
    env === "prod" ||
    env === "production"
  );
}
