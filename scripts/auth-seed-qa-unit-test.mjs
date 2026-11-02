#!/usr/bin/env node
/**
 * Unit tests for QA login-as seed: gated by DEV_AUTH, skipped in production
 * without DEV_AUTH, idempotent on rerun (no duplicate insert).
 */
import assert from "node:assert/strict";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function setEnv(map) {
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

/** In-memory fake for the two SQL shapes seedQaUser issues. */
function makeMemoryStore(initial = []) {
  /** @type {Map<string, { id: string, email: string }>} */
  const byEmail = new Map(
    initial.map((u) => [u.email.toLowerCase(), { id: u.id, email: u.email }]),
  );
  let insertCalls = 0;

  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select id from \"user\"")) {
      const email = String(params[0] || "").toLowerCase();
      const row = byEmail.get(email);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("insert into \"user\"")) {
      insertCalls += 1;
      const id = String(params[0]);
      const email = String(params[2]).toLowerCase();
      if (byEmail.has(email)) {
        return { rows: [], rowCount: 0 };
      }
      byEmail.set(email, { id, email });
      return { rows: [{ id }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in fake store: ${sql}`);
  }

  return {
    query,
    get insertCalls() {
      return insertCalls;
    },
    get size() {
      return byEmail.size;
    },
  };
}

console.log("auth-seed-qa-unit-test");

await check("seeds when DEV_AUTH is enabled", async () => {
  setEnv({
    NODE_ENV: "development",
    DEV_AUTH: "1",
    DEV_AUTH_DEFAULT_EMAIL: "qa@example.com",
  });
  const { seedQaUser } = await import(
    `../src/server/auth-seed-qa.ts?t=${Date.now()}-enabled`
  );
  const store = makeMemoryStore();
  const result = await seedQaUser({
    query: store.query,
    generateId: () => "id-seed-1",
  });
  assert.equal(result.status, "created");
  assert.equal(result.email, "qa@example.com");
  assert.equal(result.id, "id-seed-1");
  assert.equal(store.insertCalls, 1);
  assert.equal(store.size, 1);
});

await check("skips when DEV_AUTH is disabled", async () => {
  setEnv({
    NODE_ENV: "development",
    DEV_AUTH: "0",
    DEV_AUTH_DEFAULT_EMAIL: "qa@example.com",
  });
  const { seedQaUser } = await import(
    `../src/server/auth-seed-qa.ts?t=${Date.now()}-disabled`
  );
  let queryCalls = 0;
  const result = await seedQaUser({
    query: async () => {
      queryCalls += 1;
      return { rows: [], rowCount: 0 };
    },
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "disabled");
  assert.equal(queryCalls, 0);
});

await check("skips in production without DEV_AUTH", async () => {
  setEnv({
    NODE_ENV: "production",
    DEV_AUTH_DEFAULT_EMAIL: "qa@example.com",
  });
  const { seedQaUser } = await import(
    `../src/server/auth-seed-qa.ts?t=${Date.now()}-prod`
  );
  let queryCalls = 0;
  const result = await seedQaUser({
    query: async () => {
      queryCalls += 1;
      return { rows: [], rowCount: 0 };
    },
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "production");
  assert.equal(queryCalls, 0);
});

await check("no duplicate on rerun (idempotent)", async () => {
  setEnv({
    NODE_ENV: "development",
    DEV_AUTH: "1",
    DEV_AUTH_DEFAULT_EMAIL: "qa@example.com",
  });
  const { seedQaUser } = await import(
    `../src/server/auth-seed-qa.ts?t=${Date.now()}-idem`
  );
  const store = makeMemoryStore();
  const first = await seedQaUser({
    query: store.query,
    generateId: () => "id-once",
  });
  const second = await seedQaUser({
    query: store.query,
    generateId: () => "id-twice",
  });
  assert.equal(first.status, "created");
  assert.equal(second.status, "exists");
  assert.equal(second.id, "id-once");
  assert.equal(store.insertCalls, 1);
  assert.equal(store.size, 1);
});

await check("uses env email only (no hardcoded address in module)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(path.join(root, "src/server/auth-seed-qa.ts"), "utf8");
  assert.doesNotMatch(src, /@[a-z0-9.-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(src, /password\s*[:=]/i);
  assert.match(src, /getDefaultDevAuthEmail/);
  assert.match(src, /isDevAuthEnabled/);
});

restoreEnv();

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll auth-seed-qa unit tests passed.");
