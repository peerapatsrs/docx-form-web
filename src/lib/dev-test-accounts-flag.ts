import { getAppEnv, isAppEnvDev } from "./app-env";

function truthyFlag(name: string): boolean {
  const v = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Expose GET/POST /api/dev/test-* only when both gates are on.
 * Defaults OFF. Never enable on SIT/UAT/PROD (APP_ENV must be exactly `dev`).
 */
export function isDevTestAccountsExposed(): boolean {
  return isAppEnvDev() && truthyFlag("SHOW_TEST_ACCOUNTS");
}

/**
 * Seed idempotent DEV test users only when SEED_TEST_USERS=1 and APP_ENV=dev.
 * Independent of SHOW_TEST_ACCOUNTS (seed without exposing the panel).
 */
export function isDevTestUsersSeedEnabled(): boolean {
  return isAppEnvDev() && truthyFlag("SEED_TEST_USERS");
}

/** Human-readable reason when a DEV test-accounts gate fails. */
export function describeDevTestAccountsGate(): string {
  if (!isAppEnvDev()) {
    const env = getAppEnv() || "(unset)";
    return `APP_ENV=${env} (need APP_ENV=dev)`;
  }
  if (!truthyFlag("SHOW_TEST_ACCOUNTS")) {
    return "SHOW_TEST_ACCOUNTS is off";
  }
  return "ok";
}
