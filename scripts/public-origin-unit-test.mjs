#!/usr/bin/env node
/**
 * Unit tests for safe HTTPS redirect / host allowlist helpers.
 */
import assert from "node:assert/strict";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function setPublicEnv(map) {
  for (const key of [
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "BETTER_AUTH_URL",
    "RENDER_EXTERNAL_URL",
    "APP_ALLOWED_HOSTS",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, map);
}

async function loadFresh() {
  const id = `../src/lib/public-origin.ts?t=${Date.now()}-${Math.random()}`;
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

await check("rejects spoofed Host — no redirect to attacker origin", async () => {
  setPublicEnv({ APP_BASE_URL: "https://docx-form-web.onrender.com" });
  const { buildSafeHttpsRedirectUrl } = await loadFresh();
  const target = buildSafeHttpsRedirectUrl("/login", "evil.example");
  assert.equal(target, null);
});

await check("allowed host redirects to configured https base, not Host header", async () => {
  setPublicEnv({ APP_BASE_URL: "https://docx-form-web.onrender.com" });
  const { buildSafeHttpsRedirectUrl } = await loadFresh();
  const target = buildSafeHttpsRedirectUrl(
    "/account?x=1",
    "docx-form-web.onrender.com",
  );
  assert.equal(
    target,
    "https://docx-form-web.onrender.com/account?x=1",
  );
});

await check("does not use X-Forwarded-Host value as redirect authority", async () => {
  setPublicEnv({
    APP_BASE_URL: "https://docx-form-web.onrender.com",
    APP_ALLOWED_HOSTS: "docx-form-web.onrender.com",
  });
  const { buildSafeHttpsRedirectUrl } = await loadFresh();
  // Even if the presented host is allowlisted, target host must be APP_BASE_URL.
  const target = buildSafeHttpsRedirectUrl("/", "docx-form-web.onrender.com");
  assert.ok(target);
  assert.equal(new URL(target).host, "docx-form-web.onrender.com");
  assert.notEqual(new URL(target).host, "evil.example");
});

await check("skips redirect for loopback presented host", async () => {
  setPublicEnv({ APP_BASE_URL: "https://docx-form-web.onrender.com" });
  const { buildSafeHttpsRedirectUrl } = await loadFresh();
  assert.equal(buildSafeHttpsRedirectUrl("/", "127.0.0.1:3000"), null);
  assert.equal(buildSafeHttpsRedirectUrl("/", "localhost"), null);
});

await check("skips redirect when no production hosts configured", async () => {
  setPublicEnv({});
  const { buildSafeHttpsRedirectUrl } = await loadFresh();
  assert.equal(buildSafeHttpsRedirectUrl("/", "docx-form-web.onrender.com"), null);
});

await check("APP_ALLOWED_HOSTS extends allowlist; target still from APP_BASE_URL", async () => {
  setPublicEnv({
    APP_BASE_URL: "https://app.example.com",
    APP_ALLOWED_HOSTS: "alias.example.com",
  });
  const { buildSafeHttpsRedirectUrl } = await loadFresh();
  const target = buildSafeHttpsRedirectUrl("/x", "alias.example.com");
  assert.equal(target, "https://app.example.com/x");
});

await check("safeAppPathUrl never uses request host", async () => {
  setPublicEnv({ APP_BASE_URL: "https://docx-form-web.onrender.com" });
  const { safeAppPathUrl } = await loadFresh();
  assert.equal(
    safeAppPathUrl("/login"),
    "https://docx-form-web.onrender.com/login",
  );
});

await check("hostnameFromHostOrOrigin strips port", async () => {
  setPublicEnv({});
  const { hostnameFromHostOrOrigin } = await loadFresh();
  assert.equal(hostnameFromHostOrOrigin("Example.COM:443"), "example.com");
  assert.equal(
    hostnameFromHostOrOrigin("https://docx-form-web.onrender.com/path"),
    "docx-form-web.onrender.com",
  );
});

restoreEnv();

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll public-origin unit tests passed");

// Keep QA helper coverage on the same entry main's test:unit runs.
await import("./qa-unit-test.mjs");
