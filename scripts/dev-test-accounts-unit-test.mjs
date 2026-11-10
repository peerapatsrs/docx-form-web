#!/usr/bin/env node
/**
 * DEV test-accounts gates, public list shape, seed skips, login key lock,
 * and rate-limit behaviour (no live DB / session required).
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

function clearTestEnv() {
  for (const key of [
    "APP_ENV",
    "SHOW_TEST_ACCOUNTS",
    "SEED_TEST_USERS",
    "TEST_LOGIN_USER_EMAIL",
    "TEST_LOGIN_ADMIN_EMAIL",
    "TEST_LOGIN_USER_PASSWORD",
    "TEST_LOGIN_ADMIN_PASSWORD",
    "SEED_TEST_USER_EMAIL",
    "SEED_TEST_ADMIN_EMAIL",
    "SEED_TEST_USER_PASSWORD",
    "SEED_TEST_ADMIN_PASSWORD",
  ]) {
    delete process.env[key];
  }
}

function setEnv(map) {
  clearTestEnv();
  Object.assign(process.env, map);
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    clearTestEnv();
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

function freshImport(rel) {
  return import(`${rel}?t=${Date.now()}-${Math.random()}`);
}

/** In-memory fake covering seed SQL shapes. */
function makeMemoryStore(initial = []) {
  /** @type {Map<string, { id: string, email: string, role: string, plan: string, banned?: boolean }>} */
  const users = new Map(
    initial.map((u) => [
      u.email.toLowerCase(),
      {
        id: u.id,
        email: u.email.toLowerCase(),
        role: u.role || "user",
        plan: u.plan || "free",
        banned: Boolean(u.banned),
      },
    ]),
  );
  /** @type {Map<string, { id: string, userId: string, password: string, accountId: string }>} */
  const accounts = new Map();
  let insertUserCalls = 0;

  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith('select id, role, plan from "user"')) {
      const email = String(params[0] || "").toLowerCase();
      const row = users.get(email);
      return {
        rows: row
          ? [{ id: row.id, role: row.role, plan: row.plan }]
          : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (
      normalized.startsWith(
        'select id, email, name, role, plan, banned from "user"',
      )
    ) {
      const email = String(params[0] || "").toLowerCase();
      const row = users.get(email);
      return {
        rows: row
          ? [
              {
                id: row.id,
                email: row.email,
                name: row.email.split("@")[0],
                role: row.role,
                plan: row.plan,
                banned: row.banned || false,
              },
            ]
          : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (normalized.startsWith('select id from "user"')) {
      const email = String(params[0] || "").toLowerCase();
      const row = users.get(email);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith('insert into "user"')) {
      insertUserCalls += 1;
      const id = String(params[0]);
      const email = String(params[2]).toLowerCase();
      const role = String(params[3]);
      const plan = String(params[4]);
      if (users.has(email)) return { rows: [], rowCount: 0 };
      users.set(email, { id, email, role, plan, banned: false });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (normalized.startsWith('update "user"')) {
      const id = String(params[0]);
      const role = String(params[1]);
      const plan = String(params[2]);
      for (const row of users.values()) {
        if (row.id === id) {
          row.role = role;
          row.plan = plan;
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("select id from account")) {
      const userId = String(params[0]);
      for (const row of accounts.values()) {
        if (row.userId === userId) {
          return { rows: [{ id: row.id }], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("update account")) {
      const id = String(params[0]);
      const password = String(params[1]);
      const accountId = String(params[2]);
      const row = accounts.get(id);
      if (row) {
        row.password = password;
        row.accountId = accountId;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith("insert into account")) {
      const id = String(params[0]);
      const accountId = String(params[1]);
      const userId = String(params[2]);
      const password = String(params[3]);
      accounts.set(id, { id, accountId, userId, password });
      return { rows: [{ id }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in fake store: ${sql}`);
  }

  return {
    query,
    users,
    accounts,
    get insertUserCalls() {
      return insertUserCalls;
    },
  };
}

console.log("dev-test-accounts-unit-test");

await check("isAppEnvDev requires APP_ENV=dev exactly", async () => {
  setEnv({ APP_ENV: "dev" });
  const { isAppEnvDev } = await freshImport("../src/lib/app-env.ts");
  assert.equal(isAppEnvDev(), true);

  setEnv({ APP_ENV: "production" });
  const prod = await freshImport("../src/lib/app-env.ts");
  assert.equal(prod.isAppEnvDev(), false);

  setEnv({ APP_ENV: "sit" });
  const sit = await freshImport("../src/lib/app-env.ts");
  assert.equal(sit.isAppEnvDev(), false);
  assert.equal(sit.isAppEnvNonDevHost(), true);

  setEnv({});
  const unset = await freshImport("../src/lib/app-env.ts");
  assert.equal(unset.isAppEnvDev(), false);
});

await check("expose gate needs APP_ENV=dev AND SHOW_TEST_ACCOUNTS=1", async () => {
  setEnv({ APP_ENV: "dev", SHOW_TEST_ACCOUNTS: "1" });
  const on = await freshImport("../src/lib/dev-test-accounts-flag.ts");
  assert.equal(on.isDevTestAccountsExposed(), true);

  setEnv({ APP_ENV: "dev", SHOW_TEST_ACCOUNTS: "0" });
  const offFlag = await freshImport("../src/lib/dev-test-accounts-flag.ts");
  assert.equal(offFlag.isDevTestAccountsExposed(), false);

  setEnv({ APP_ENV: "prod", SHOW_TEST_ACCOUNTS: "1" });
  const prod = await freshImport("../src/lib/dev-test-accounts-flag.ts");
  assert.equal(prod.isDevTestAccountsExposed(), false);

  setEnv({ SHOW_TEST_ACCOUNTS: "1" });
  const noEnv = await freshImport("../src/lib/dev-test-accounts-flag.ts");
  assert.equal(noEnv.isDevTestAccountsExposed(), false);
});

await check("seed gate needs APP_ENV=dev AND SEED_TEST_USERS=1", async () => {
  setEnv({ APP_ENV: "dev", SEED_TEST_USERS: "1" });
  const on = await freshImport("../src/lib/dev-test-accounts-flag.ts");
  assert.equal(on.isDevTestUsersSeedEnabled(), true);

  setEnv({ APP_ENV: "uat", SEED_TEST_USERS: "1" });
  const uat = await freshImport("../src/lib/dev-test-accounts-flag.ts");
  assert.equal(uat.isDevTestUsersSeedEnabled(), false);
});

await check("public list has no passwords/emails", async () => {
  setEnv({
    APP_ENV: "dev",
    TEST_LOGIN_USER_EMAIL: "u@example.com",
    TEST_LOGIN_USER_PASSWORD: "secret-user",
    TEST_LOGIN_ADMIN_EMAIL: "a@example.com",
    TEST_LOGIN_ADMIN_PASSWORD: "secret-admin",
  });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  const list = mod.listPublicTestAccounts();
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    key: "user",
    label: "ผู้ใช้ทดสอบ",
    role: "user",
  });
  assert.deepEqual(list[1], {
    key: "admin",
    label: "แอดมินทดสอบ",
    role: "admin",
  });
  const blob = JSON.stringify(list);
  assert.equal(blob.includes("secret"), false);
  assert.equal(blob.includes("@"), false);
  assert.equal(blob.includes("password"), false);
});

await check("GET helper returns 404 when flags off", async () => {
  setEnv({ APP_ENV: "prod", SHOW_TEST_ACCOUNTS: "1" });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  mod.resetDevTestAccountsRateLimit();
  const res = mod.getTestAccountsResponse({ ip: "203.0.113.1" });
  assert.equal(res.status, 404);
});

await check("GET helper returns 200 array when exposed", async () => {
  setEnv({ APP_ENV: "dev", SHOW_TEST_ACCOUNTS: "1" });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  mod.resetDevTestAccountsRateLimit();
  const res = mod.getTestAccountsResponse({
    ip: "203.0.113.2",
    isExposed: () => true,
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].key, "user");
});

await check("seed skips when SEED_TEST_USERS off", async () => {
  setEnv({ APP_ENV: "dev" });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  const store = makeMemoryStore();
  const warnings = [];
  const result = await mod.seedTestUsers({
    query: store.query,
    warn: (m) => warnings.push(m),
    hashPassword: async (p) => `hash:${p}`,
    generateId: () => "id-1",
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "disabled");
  assert.equal(store.insertUserCalls, 0);
});

await check("seed skips + warns when APP_ENV=prod even with flags", async () => {
  setEnv({ APP_ENV: "prod", SEED_TEST_USERS: "1", SHOW_TEST_ACCOUNTS: "1" });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  const store = makeMemoryStore();
  const warnings = [];
  const result = await mod.seedTestUsers({
    query: store.query,
    warn: (m) => warnings.push(m),
    hashPassword: async (p) => `hash:${p}`,
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "not_dev");
  assert.equal(store.insertUserCalls, 0);
  assert.ok(warnings.some((w) => /APP_ENV=prod/.test(w)));
});

await check("seed creates user+admin when enabled", async () => {
  setEnv({
    APP_ENV: "dev",
    SEED_TEST_USERS: "1",
    TEST_LOGIN_USER_EMAIL: "tu@example.com",
    TEST_LOGIN_ADMIN_EMAIL: "ta@example.com",
    TEST_LOGIN_USER_PASSWORD: "pw-user",
    TEST_LOGIN_ADMIN_PASSWORD: "pw-admin",
  });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  const store = makeMemoryStore();
  let id = 0;
  const result = await mod.seedTestUsers({
    query: store.query,
    hashPassword: async (p) => `hash:${p}`,
    generateId: () => `id-${++id}`,
  });
  assert.equal(result.status, "seeded");
  assert.deepEqual(result.created.sort(), ["admin", "user"]);
  assert.equal(store.users.size, 2);
  assert.equal(store.accounts.size, 2);
  assert.equal(store.users.get("tu@example.com").role, "user");
  assert.equal(store.users.get("ta@example.com").role, "admin");
});

await check("login rejects when feature off", async () => {
  setEnv({ APP_ENV: "dev" });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  const result = await mod.performTestLogin(
    new Request("http://localhost/api/dev/test-login", { method: "POST" }),
    { key: "user" },
    { isExposed: () => false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

await check("login rejects unknown key with 404", async () => {
  setEnv({ APP_ENV: "dev", SHOW_TEST_ACCOUNTS: "1" });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  mod.resetDevTestAccountsRateLimit();
  const result = await mod.performTestLogin(
    new Request("http://localhost/api/dev/test-login", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.9" },
    }),
    { key: "someone-else" },
    {
      isExposed: () => true,
      allowLogin: () => true,
      query: makeMemoryStore().query,
      createSession: async () => {
        throw new Error("should not create session for unknown key");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

await check("login only works for configured seeded key", async () => {
  setEnv({
    APP_ENV: "dev",
    SHOW_TEST_ACCOUNTS: "1",
    TEST_LOGIN_USER_EMAIL: "tu@example.com",
    TEST_LOGIN_ADMIN_EMAIL: "ta@example.com",
  });
  const mod = await freshImport("../src/server/dev-test-accounts.ts");
  mod.resetDevTestAccountsRateLimit();
  const store = makeMemoryStore([
    { id: "u1", email: "tu@example.com", role: "user", plan: "free" },
    { id: "a1", email: "ta@example.com", role: "admin", plan: "pro" },
  ]);
  const audits = [];
  const result = await mod.performTestLogin(
    new Request("http://localhost/api/dev/test-login", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.10" },
    }),
    { key: "admin" },
    {
      isExposed: () => true,
      allowLogin: () => true,
      query: store.query,
      createSession: async (userId) => ({
        setCookie: `better-auth.session_token=signed-${userId}; Path=/; HttpOnly`,
        user: {
          id: userId,
          email: "ta@example.com",
          name: "admin",
          role: "admin",
          plan: "pro",
        },
      }),
      writeAudit: async (entry) => {
        audits.push(entry);
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.ok(String(result.setCookie).includes("better-auth.session_token"));
  assert.equal(result.user.role, "admin");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "dev.test_login");
});

await check("api.ts wires /dev/test-accounts and /dev/test-login", async () => {
  const src = readFileSync(path.join(root, "src/server/api.ts"), "utf8");
  assert.match(src, /\/dev\/test-accounts/);
  assert.match(src, /\/dev\/test-login/);
  assert.match(src, /performTestLogin/);
  assert.match(src, /Set-Cookie/);
});

await check("docs cover gates and FE contract shapes", async () => {
  const doc = readFileSync(
    path.join(root, "docs/DEV-TEST-ACCOUNTS.md"),
    "utf8",
  );
  assert.match(doc, /APP_ENV=dev/);
  assert.match(doc, /SHOW_TEST_ACCOUNTS/);
  assert.match(doc, /SEED_TEST_USERS/);
  assert.match(doc, /GET \/api\/dev\/test-accounts/);
  assert.match(doc, /POST \/api\/dev\/test-login/);
  assert.match(doc, /\/admin/);
  assert.match(doc, /better-auth\.session_token/);
});

restoreEnv();

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll dev-test-accounts checks passed");
