#!/usr/bin/env node
/**
 * Regression: dev-auth plugin must load via ESM and stay gated by DEV_AUTH.
 * Guards the next-build failure where CJS require() of the plugin was non-callable.
 */
import assert from "node:assert/strict";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function setDevAuthEnv(map) {
  for (const key of [
    "DEV_AUTH",
    "DEV_AUTH_DEFAULT_EMAIL",
    "SUPERADMIN_EMAILS",
    "NODE_ENV",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, map);
}

async function loadFlagFresh() {
  const id = `../src/lib/dev-auth-flag.ts?t=${Date.now()}-${Math.random()}`;
  return import(id);
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${name}`);
      console.error(err);
    }
  })();
}

console.log("dev-auth-unit-test");

await check("isDevAuthEnabled respects DEV_AUTH=1 in production NODE_ENV", async () => {
  setDevAuthEnv({ NODE_ENV: "production", DEV_AUTH: "1" });
  const { isDevAuthEnabled } = await loadFlagFresh();
  assert.equal(isDevAuthEnabled(), true);
});

await check("isDevAuthEnabled stays off in production without DEV_AUTH", async () => {
  setDevAuthEnv({ NODE_ENV: "production" });
  const { isDevAuthEnabled } = await loadFlagFresh();
  assert.equal(isDevAuthEnabled(), false);
});

await check("isDevAuthEnabled auto-on outside production", async () => {
  setDevAuthEnv({ NODE_ENV: "development" });
  const { isDevAuthEnabled } = await loadFlagFresh();
  assert.equal(isDevAuthEnabled(), true);
});

await check("isDevAuthEnabled can be forced off with DEV_AUTH=0", async () => {
  setDevAuthEnv({ NODE_ENV: "development", DEV_AUTH: "0" });
  const { isDevAuthEnabled } = await loadFlagFresh();
  assert.equal(isDevAuthEnabled(), false);
});

await check("getDefaultDevAuthEmail prefers DEV_AUTH_DEFAULT_EMAIL", async () => {
  setDevAuthEnv({
    DEV_AUTH_DEFAULT_EMAIL: "dev@example.com",
    SUPERADMIN_EMAILS: "admin@example.com",
  });
  const { getDefaultDevAuthEmail } = await loadFlagFresh();
  assert.equal(getDefaultDevAuthEmail(), "dev@example.com");
});

await check("getDefaultDevAuthEmail falls back to SUPERADMIN_EMAILS", async () => {
  setDevAuthEnv({ SUPERADMIN_EMAILS: " admin@example.com , other@example.com" });
  const { getDefaultDevAuthEmail } = await loadFlagFresh();
  assert.equal(getDefaultDevAuthEmail(), "admin@example.com");
});

await check("devAuthPlugin ESM export is callable (build-time / auth.ts load path)", async () => {
  // Mirrors the static import auth.ts uses. A non-function here would break
  // `next build` page-data collection whenever DEV_AUTH enables the plugin.
  const { devAuthPlugin } = await import("../src/server/dev-auth-plugin.ts");
  assert.equal(typeof devAuthPlugin, "function");
  const plugin = devAuthPlugin();
  assert.equal(plugin.id, "dev-auth");
  assert.ok(plugin.endpoints);
  assert.ok(plugin.endpoints.listDevUsers);
  assert.ok(plugin.endpoints.loginAsDevUser);
});

await check("production + DEV_AUTH includes plugin factory result like auth.ts", async () => {
  setDevAuthEnv({ NODE_ENV: "production", DEV_AUTH: "1" });
  const { isDevAuthEnabled } = await loadFlagFresh();
  const { devAuthPlugin } = await import("../src/server/dev-auth-plugin.ts");
  const plugins = isDevAuthEnabled() ? [devAuthPlugin()] : [];
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, "dev-auth");
});

await check("production without DEV_AUTH omits plugin", async () => {
  setDevAuthEnv({ NODE_ENV: "production" });
  const { isDevAuthEnabled } = await loadFlagFresh();
  const { devAuthPlugin } = await import("../src/server/dev-auth-plugin.ts");
  const plugins = isDevAuthEnabled() ? [devAuthPlugin()] : [];
  assert.equal(plugins.length, 0);
  assert.equal(typeof devAuthPlugin, "function");
});

restoreEnv();

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll dev-auth unit tests passed.");
