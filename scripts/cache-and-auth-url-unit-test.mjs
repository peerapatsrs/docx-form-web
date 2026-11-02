#!/usr/bin/env node
/**
 * Unit tests for private document cache headers and Better Auth base URL
 * precedence (BETTER_AUTH_URL over getAppBaseUrl).
 */
import assert from "node:assert/strict";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function clearPublicEnv() {
  for (const key of [
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "BETTER_AUTH_URL",
    "RENDER_EXTERNAL_URL",
  ]) {
    delete process.env[key];
  }
}

async function loadSecurityHeaders() {
  const id = `../src/lib/security-headers.ts?t=${Date.now()}-${Math.random()}`;
  return import(id);
}

async function loadAppBaseUrl() {
  const id = `../src/lib/app-base-url.ts?t=${Date.now()}-${Math.random()}`;
  return import(id);
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    clearPublicEnv();
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

await check("private paths: /account and /admin (and nested)", async () => {
  const {
    isPrivateDocumentPath,
    documentCacheControl,
    PRIVATE_NO_STORE_CACHE_CONTROL,
    HTML_CACHE_CONTROL,
  } = await loadSecurityHeaders();

  for (const path of [
    "/account",
    "/account/",
    "/account/billing",
    "/admin",
    "/admin/",
    "/admin/users",
    "/admin/limits",
  ]) {
    assert.equal(isPrivateDocumentPath(path), true, path);
    assert.equal(
      documentCacheControl(path),
      PRIVATE_NO_STORE_CACHE_CONTROL,
      path,
    );
  }

  assert.equal(PRIVATE_NO_STORE_CACHE_CONTROL, "private, no-store");
  assert.match(HTML_CACHE_CONTROL, /public/);
  assert.match(HTML_CACHE_CONTROL, /s-maxage=60/);
});

await check("public paths keep shared HTML cache control", async () => {
  const {
    isPrivateDocumentPath,
    documentCacheControl,
    HTML_CACHE_CONTROL,
  } = await loadSecurityHeaders();

  for (const path of ["/", "/login", "/robots.txt", "/sitemap.xml", "/about"]) {
    assert.equal(isPrivateDocumentPath(path), false, path);
    assert.equal(documentCacheControl(path), HTML_CACHE_CONTROL, path);
  }

  // Prefix lookalikes must not be treated as private account/admin trees.
  assert.equal(isPrivateDocumentPath("/accountant"), false);
  assert.equal(isPrivateDocumentPath("/administration"), false);
  assert.equal(documentCacheControl("/accountant"), HTML_CACHE_CONTROL);
});

await check("BETTER_AUTH_URL wins over APP_BASE_URL for auth origin", async () => {
  process.env.APP_BASE_URL = "https://app.example.com";
  process.env.BETTER_AUTH_URL = "https://auth.example.com";
  const { getAppBaseUrl, getBetterAuthBaseUrl } = await loadAppBaseUrl();
  assert.equal(getAppBaseUrl(), "https://app.example.com");
  assert.equal(getBetterAuthBaseUrl(), "https://auth.example.com");
});

await check("getBetterAuthBaseUrl falls back to getAppBaseUrl", async () => {
  process.env.APP_BASE_URL = "https://app.example.com";
  const { getAppBaseUrl, getBetterAuthBaseUrl } = await loadAppBaseUrl();
  assert.equal(getBetterAuthBaseUrl(), getAppBaseUrl());
  assert.equal(getBetterAuthBaseUrl(), "https://app.example.com");
});

await check("getBetterAuthBaseUrl uses BETTER_AUTH_URL alone when only set", async () => {
  process.env.BETTER_AUTH_URL = "https://auth-only.example.com/";
  const { getBetterAuthBaseUrl, getAppBaseUrl } = await loadAppBaseUrl();
  assert.equal(getBetterAuthBaseUrl(), "https://auth-only.example.com");
  // Site base may still resolve via BETTER_AUTH_URL as a lower-priority fallback.
  assert.equal(getAppBaseUrl(), "https://auth-only.example.com");
});

await check("trims trailing slash on BETTER_AUTH_URL", async () => {
  process.env.APP_BASE_URL = "https://app.example.com";
  process.env.BETTER_AUTH_URL = "https://auth.example.com/";
  const { getBetterAuthBaseUrl } = await loadAppBaseUrl();
  assert.equal(getBetterAuthBaseUrl(), "https://auth.example.com");
});

restoreEnv();

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll cache / Better Auth URL unit tests passed");
