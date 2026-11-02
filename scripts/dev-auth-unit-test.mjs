#!/usr/bin/env node
/**
 * Regression: dev-auth plugin must load via ESM and stay gated by DEV_AUTH.
 * Guards the next-build failure where CJS require() of the plugin was non-callable.
 * Also asserts no hardcoded default emails and side-effect-free plugin module load.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const saved = { ...process.env };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function loadEmailFresh() {
  // Plain helper (no server-only) — same module migrate/plugin use.
  const id = `../src/server/dev-auth-default-email.ts?t=${Date.now()}-${Math.random()}`;
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
  const { getDefaultDevAuthEmail } = await loadEmailFresh();
  assert.equal(getDefaultDevAuthEmail(), "dev@example.com");
});

await check("getDefaultDevAuthEmail falls back to SUPERADMIN_EMAILS", async () => {
  setDevAuthEnv({ SUPERADMIN_EMAILS: " admin@example.com , other@example.com" });
  const { getDefaultDevAuthEmail } = await loadEmailFresh();
  assert.equal(getDefaultDevAuthEmail(), "admin@example.com");
});

await check("getDefaultDevAuthEmail returns undefined when unset (no hardcoded email)", async () => {
  setDevAuthEnv({ NODE_ENV: "development" });
  const { getDefaultDevAuthEmail } = await loadEmailFresh();
  assert.equal(getDefaultDevAuthEmail(), undefined);
});

await check("plain email helper has no server-only; wrapper does", async () => {
  const flagSrc = readFileSync(path.join(root, "src/lib/dev-auth-flag.ts"), "utf8");
  assert.doesNotMatch(flagSrc, /getDefaultDevAuthEmail/);
  assert.doesNotMatch(flagSrc, /@[a-z0-9.-]+\.[a-z]{2,}/i);

  const plainSrc = readFileSync(
    path.join(root, "src/server/dev-auth-default-email.ts"),
    "utf8",
  );
  assert.doesNotMatch(plainSrc, /server-only/);
  assert.doesNotMatch(plainSrc, /@[a-z0-9.-]+\.[a-z]{2,}/i);

  const wrapSrc = readFileSync(
    path.join(root, "src/server/dev-auth-email.ts"),
    "utf8",
  );
  assert.match(wrapSrc, /import\s+["']server-only["']/);

  const pluginSrc = readFileSync(
    path.join(root, "src/server/dev-auth-plugin.ts"),
    "utf8",
  );
  assert.match(pluginSrc, /dev-auth-default-email/);
  assert.doesNotMatch(pluginSrc, /from\s+["']\.\/dev-auth-email["']/);
});

await check("dev-auth-plugin has no literal email and lazy getAuthPool only", async () => {
  const src = readFileSync(
    path.join(root, "src/server/dev-auth-plugin.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /@[a-z0-9.-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(src, /peerapat/i);

  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const lines = stripped.split("\n");
  let depth = 0;
  for (const line of lines) {
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    if (depth === 0 && /\bgetAuthPool\s*\(/.test(line)) {
      assert.fail(`getAuthPool() must not run at module top level: ${line.trim()}`);
    }
    depth += open - close;
  }
  assert.match(src, /getAuthPool\s*\(/);
});

await check("devAuthPlugin ESM export is callable (build-time / auth.ts load path)", async () => {
  const { devAuthPlugin } = await import("../src/server/dev-auth-plugin.ts");
  assert.equal(typeof devAuthPlugin, "function");
  const plugin = devAuthPlugin();
  assert.equal(plugin.id, "dev-auth");
  assert.ok(plugin.endpoints);
  assert.ok(plugin.endpoints.listDevUsers);
  assert.ok(plugin.endpoints.loginAsDevUser);
});

await check("importing/calling factory does not open auth pool", async () => {
  const authDb = await import(`../src/server/auth-db.ts?t=${Date.now()}`);
  assert.equal(typeof authDb.getAuthPool, "function");

  delete process.env.DATABASE_URL;
  const { devAuthPlugin } = await import(
    `../src/server/dev-auth-plugin.ts?t=${Date.now()}`
  );
  assert.doesNotThrow(() => {
    const plugin = devAuthPlugin();
    assert.equal(plugin.id, "dev-auth");
  });
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
