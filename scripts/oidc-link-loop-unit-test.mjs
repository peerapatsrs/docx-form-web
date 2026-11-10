#!/usr/bin/env node
/**
 * OIDC account-linking + login loop-breaker unit tests.
 * Covers IdP email_verified × app emailVerified for Google-era users,
 * case-insensitive email, brand-new users, trust-off error, and fail cookie.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function clearOidcEnv() {
  for (const key of [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_TRUST_IDP_EMAIL",
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "BETTER_AUTH_URL",
  ]) {
    delete process.env[key];
  }
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    clearOidcEnv();
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

async function load(mod) {
  return import(`../${mod}?t=${Date.now()}-${Math.random()}`);
}

const ISSUER = "https://auth.tps18.space/realms/tps18-dev";
const CLIENT_ID = "docx-form-web";

function memoryDb() {
  /** @type {Map<string, any>} */
  const identities = new Map();
  /** @type {Map<string, any>} */
  const users = new Map();
  /** @type {Map<string, any>} */
  const accounts = new Map();

  /** @type {import('../src/server/oidc-identities.ts').QueryFn} */
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (
      s.startsWith("CREATE TABLE") ||
      s.startsWith("CREATE INDEX") ||
      s.includes("ALTER TABLE oidc_login_state")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      s.includes("FROM identities") &&
      s.includes("issuer = $1") &&
      s.includes("subject = $2")
    ) {
      const row = identities.get(`${params[0]}|${params[1]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (
      s.includes("FROM identities") &&
      s.includes("issuer = $1") &&
      s.includes('"userId" = $2')
    ) {
      for (const row of identities.values()) {
        if (row.issuer === params[0] && row.userId === params[1]) {
          return { rows: [row], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM "user"') && s.includes("lower(email)")) {
      const email = String(params[0]).toLowerCase();
      for (const u of users.values()) {
        if (String(u.email).toLowerCase() === email) {
          return { rows: [{ id: u.id }], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('UPDATE "user"') && s.includes('"emailVerified" = true')) {
      const u = users.get(params[0]);
      if (u) {
        u.emailVerified = true;
        users.set(u.id, u);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('INSERT INTO "user"')) {
      const [id, name, email, emailVerified, image, role, plan] = params;
      const emailKey = String(email).toLowerCase();
      for (const u of users.values()) {
        if (String(u.email).toLowerCase() === emailKey) {
          // ON CONFLICT DO NOTHING
          return { rows: [], rowCount: 0 };
        }
      }
      users.set(id, { id, name, email: emailKey, emailVerified, image, role, plan });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (s.includes("INSERT INTO identities") && s.includes("ON CONFLICT")) {
      const [id, issuer, subject, userId, email, emailVerified] = params;
      const key = `${issuer}|${subject}`;
      const row = {
        id: identities.get(key)?.id || id,
        issuer,
        subject,
        userId,
        email,
        emailVerified,
      };
      identities.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes("INSERT INTO identities")) {
      const [id, issuer, subject, userId, email, emailVerified] = params;
      const row = { id, issuer, subject, userId, email, emailVerified };
      identities.set(`${issuer}|${subject}`, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes("UPDATE identities")) {
      const [userId, email, emailVerified, id] = params;
      for (const [k, row] of identities) {
        if (row.id === id) {
          const next = { ...row, userId, email, emailVerified };
          identities.set(k, next);
          return { rows: [], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected SQL: ${s.slice(0, 140)}`);
  };

  return { identities, users, accounts, query };
}

function seedGoogleEraUser(db, opts) {
  const id = opts.id || "u-google";
  db.users.set(id, {
    id,
    email: opts.email,
    emailVerified: opts.emailVerified,
    role: opts.role || "user",
    plan: opts.plan || "free",
    name: opts.name || "Google User",
  });
  db.accounts.set(`google|${id}`, {
    id: `acc-${id}`,
    providerId: "google",
    accountId: `g-${id}`,
    userId: id,
  });
  return id;
}

function claims(opts) {
  return {
    iss: ISSUER,
    sub: opts.sub,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: opts.email,
    email_verified: opts.email_verified,
    name: opts.name || "User",
  };
}

await check("OIDC_TRUST_IDP_EMAIL defaults true; false/0/off disable", async () => {
  const { isOidcTrustIdpEmail } = await load("src/server/oidc-identities.ts");
  assert.equal(isOidcTrustIdpEmail({}), true);
  assert.equal(isOidcTrustIdpEmail({ OIDC_TRUST_IDP_EMAIL: "true" }), true);
  assert.equal(isOidcTrustIdpEmail({ OIDC_TRUST_IDP_EMAIL: "false" }), false);
  assert.equal(isOidcTrustIdpEmail({ OIDC_TRUST_IDP_EMAIL: "0" }), false);
  assert.equal(isOidcTrustIdpEmail({ OIDC_TRUST_IDP_EMAIL: "off" }), false);
});

for (const idpVerified of [true, false]) {
  for (const appVerified of [true, false]) {
    await check(
      `trust=on links existing Google user (IdP verified=${idpVerified}, app verified=${appVerified})`,
      async () => {
        const {
          resolveUserForOidcClaims,
          resetOidcIdentitiesSchemaGate,
        } = await load("src/server/oidc-identities.ts");
        resetOidcIdentitiesSchemaGate();
        const db = memoryDb();
        const userId = seedGoogleEraUser(db, {
          email: "Peerapat@Example.com",
          emailVerified: appVerified,
        });
        assert.ok(db.accounts.get(`google|${userId}`));
        assert.equal(db.accounts.get(`google|${userId}`).providerId, "google");

        const result = await resolveUserForOidcClaims(
          claims({
            sub: `sub-${idpVerified}-${appVerified}`,
            email: "peerapat@example.com",
            email_verified: idpVerified,
          }),
          { query: db.query, trustIdpEmail: true },
        );
        assert.equal(result.linkedBy, "email");
        assert.equal(result.userId, userId);
        assert.equal(db.users.get(userId).emailVerified, true);
        assert.equal(db.users.get(userId).role, "user");
        assert.equal(db.users.get(userId).plan, "free");
        assert.equal(db.users.size, 1);
      },
    );
  }
}

await check("case-insensitive email links existing user", async () => {
  const {
    resolveUserForOidcClaims,
    resetOidcIdentitiesSchemaGate,
  } = await load("src/server/oidc-identities.ts");
  resetOidcIdentitiesSchemaGate();
  const db = memoryDb();
  const userId = seedGoogleEraUser(db, {
    email: "Case.User@Example.COM",
    emailVerified: false,
  });
  const result = await resolveUserForOidcClaims(
    claims({
      sub: "sub-case",
      email: "case.user@example.com",
      email_verified: false,
    }),
    { query: db.query, trustIdpEmail: true },
  );
  assert.equal(result.userId, userId);
  assert.equal(result.linkedBy, "email");
});

await check("brand-new user is created once", async () => {
  const {
    resolveUserForOidcClaims,
    resetOidcIdentitiesSchemaGate,
  } = await load("src/server/oidc-identities.ts");
  resetOidcIdentitiesSchemaGate();
  const db = memoryDb();
  const first = await resolveUserForOidcClaims(
    claims({
      sub: "sub-new",
      email: "newbie@example.com",
      email_verified: true,
    }),
    { query: db.query, trustIdpEmail: true },
  );
  assert.equal(first.linkedBy, "created");
  assert.equal(db.users.size, 1);
  const second = await resolveUserForOidcClaims(
    claims({
      sub: "sub-new",
      email: "newbie@example.com",
      email_verified: true,
    }),
    { query: db.query, trustIdpEmail: true },
  );
  assert.equal(second.linkedBy, "identity");
  assert.equal(second.userId, first.userId);
  assert.equal(db.users.size, 1);
});

await check("ON CONFLICT email during create links instead of throwing", async () => {
  const {
    resolveUserForOidcClaims,
    resetOidcIdentitiesSchemaGate,
  } = await load("src/server/oidc-identities.ts");
  resetOidcIdentitiesSchemaGate();
  const db = memoryDb();
  // Pre-seed so email lookup is somehow skipped is not the case — force create
  // path by using trust off + verified false with NO existing... actually that
  // creates. Simulate race: seed after mayLink would have run by inserting user
  // with same email via direct map before create's INSERT — use create path when
  // trust off, verified true, but inject conflict by pre-seeding immediately
  // before create: easier — call createAppUserFromOidc with pre-seeded email.
  const { createAppUserFromOidc } = await load("src/server/oidc-identities.ts");
  seedGoogleEraUser(db, {
    id: "u-race",
    email: "race@example.com",
    emailVerified: false,
  });
  const out = await createAppUserFromOidc(
    claims({
      sub: "sub-race",
      email: "race@example.com",
      email_verified: true,
    }),
    db.query,
  );
  assert.equal(out.created, false);
  assert.equal(out.userId, "u-race");
  assert.equal(db.users.size, 1);
  assert.equal(db.users.get("u-race").emailVerified, true);
});

await check("trust=off + IdP unverified + existing user → clear error (no duplicate)", async () => {
  const {
    resolveUserForOidcClaims,
    OidcEmailUnverifiedError,
    resetOidcIdentitiesSchemaGate,
  } = await load("src/server/oidc-identities.ts");
  resetOidcIdentitiesSchemaGate();
  const db = memoryDb();
  seedGoogleEraUser(db, {
    email: "exist@example.com",
    emailVerified: false,
  });
  await assert.rejects(
    () =>
      resolveUserForOidcClaims(
        claims({
          sub: "sub-unverified",
          email: "exist@example.com",
          email_verified: false,
        }),
        { query: db.query, trustIdpEmail: false },
      ),
    (err) =>
      err instanceof OidcEmailUnverifiedError ||
      err?.code === "OIDC_EMAIL_UNVERIFIED",
  );
  assert.equal(db.users.size, 1);
  assert.equal(db.identities.size, 0);
});

await check("trust=off + IdP verified links even if app emailVerified=false", async () => {
  const {
    resolveUserForOidcClaims,
    resetOidcIdentitiesSchemaGate,
  } = await load("src/server/oidc-identities.ts");
  resetOidcIdentitiesSchemaGate();
  const db = memoryDb();
  const userId = seedGoogleEraUser(db, {
    email: "ok@example.com",
    emailVerified: false,
  });
  const result = await resolveUserForOidcClaims(
    claims({
      sub: "sub-trust-off-verified",
      email: "ok@example.com",
      email_verified: true,
    }),
    { query: db.query, trustIdpEmail: false },
  );
  assert.equal(result.linkedBy, "email");
  assert.equal(result.userId, userId);
  assert.equal(db.users.get(userId).emailVerified, true);
});

await check("fail cookie blocks auto-redirect after 2 failures in 60s", async () => {
  const {
    parseOidcFailCookie,
    bumpOidcFailState,
    shouldBlockOidcAutoRedirect,
    serializeOidcFailState,
    oidcLoginErrorCopy,
    OIDC_FAIL_THRESHOLD,
  } = await load("src/server/oidc-login-guard.ts");
  const t0 = 1_700_000_000_000;
  let state = parseOidcFailCookie(undefined, t0);
  assert.equal(shouldBlockOidcAutoRedirect(undefined, t0), false);
  state = bumpOidcFailState(state, t0);
  assert.equal(state.count, 1);
  assert.equal(
    shouldBlockOidcAutoRedirect(serializeOidcFailState(state), t0),
    false,
  );
  state = bumpOidcFailState(state, t0 + 1_000);
  assert.equal(state.count, OIDC_FAIL_THRESHOLD);
  assert.equal(
    shouldBlockOidcAutoRedirect(serializeOidcFailState(state), t0 + 1_000),
    true,
  );
  // Window expiry resets.
  assert.equal(
    shouldBlockOidcAutoRedirect(
      serializeOidcFailState(state),
      t0 + 61_000,
    ),
    false,
  );
  const copy = oidcLoginErrorCopy("oidc_callback_failed");
  assert.match(copy.title, /เข้าสู่ระบบ/);
  assert.match(copy.lead, /oidc_callback_failed/);
  const unverified = oidcLoginErrorCopy("oidc_email_unverified");
  assert.match(unverified.title, /อีเมล/);
});

await check("login page never auto-redirects when ?error= present", async () => {
  const login = readFileSync(join(root, "src/app/login/page.tsx"), "utf8");
  assert.match(login, /LoginErrorPanel/);
  assert.match(login, /params\.error|errorRaw/);
  assert.match(login, /shouldBlockOidcAutoRedirect/);
  assert.match(login, /\/api\/auth\/oidc\/login/);
  assert.match(login, /\/api\/auth\/oidc\/logout/);
  assert.match(login, /ลองเข้าใหม่/);
  // Auto redirect only after error/guard checks (interactive via login API).
  const errorIdx = login.indexOf("if (errorRaw)");
  const redirectIdx = login.lastIndexOf("/api/auth/oidc/login");
  assert.ok(errorIdx >= 0 && redirectIdx > errorIdx);
  assert.doesNotMatch(login, /prompt:\s*[\"']none[\"']/);
});

if (failed > 0) {
  console.error(`\n${failed} oidc-link-loop unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-link-loop unit tests passed");
