#!/usr/bin/env node
/**
 * Unit tests for build commit → version label (RENDER_GIT_COMMIT / GIT_SHA / …).
 */
import assert from "node:assert/strict";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function clearCommitEnv() {
  for (const key of [
    "RENDER_GIT_COMMIT",
    "SOURCE_COMMIT",
    "GIT_SHA",
    "COMMIT_SHA",
    "VERCEL_GIT_COMMIT_SHA",
    "APP_BUILD_SHA",
    "APP_BUILD_COMMIT_ENV",
  ]) {
    delete process.env[key];
  }
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    clearCommitEnv();
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

async function load() {
  return import(`../src/lib/app-build-info.ts?t=${Date.now()}-${Math.random()}`);
}

await check("falls back to package version when no commit env", async () => {
  const { formatAppVersionLabel, readBuildCommitSha } = await load();
  assert.equal(readBuildCommitSha({}), null);
  assert.equal(formatAppVersionLabel("0.1.0", {}), "v0.1.0");
});

await check("prefers RENDER_GIT_COMMIT short SHA", async () => {
  const { formatAppVersionLabel, shortCommitSha } = await load();
  const env = {
    RENDER_GIT_COMMIT: "5416d7677cdb9c334759c5602d90f2c2d6fe5252",
  };
  assert.equal(shortCommitSha(env.RENDER_GIT_COMMIT), "5416d76");
  assert.equal(formatAppVersionLabel("0.1.0", env), "5416d76");
});

await check("APP_BUILD_COMMIT_ENV selects which var to read", async () => {
  const { formatAppVersionLabel } = await load();
  const env = {
    APP_BUILD_COMMIT_ENV: "GIT_SHA",
    RENDER_GIT_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    GIT_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  };
  assert.equal(formatAppVersionLabel("9.9.9", env), "bbbbbbb");
});

await check("APP_BUILD_SHA direct override wins", async () => {
  const { formatAppVersionLabel } = await load();
  const env = {
    APP_BUILD_SHA: "ccccccccddddddddeeeeeeeeffffffff00000000",
    RENDER_GIT_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.equal(formatAppVersionLabel("0.1.0", env), "ccccccc");
});

await check("entitlement/hono path uses formatAppVersionLabel", async () => {
  const hono = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/server/hono-app.ts", import.meta.url), "utf8"),
  );
  assert.match(hono, /formatAppVersionLabel/);
  const api = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8"),
  );
  assert.match(api, /short build commit|RENDER_GIT_COMMIT|GIT_SHA/);
});

if (failed > 0) {
  console.error(`\n${failed} app-build-info unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll app-build-info unit tests passed");
