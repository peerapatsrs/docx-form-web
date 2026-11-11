#!/usr/bin/env node
/**
 * AI keys vault: create/list/replace/test/delete + ownership + audit + masking.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://docx:docx@127.0.0.1:5432/docx_form";
process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET || "unit-test-secret-32chars-min!!!!";

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}

async function loadFresh(rel) {
  const url = pathToFileURL(join(root, rel)).href + `?t=${Date.now()}-${Math.random()}`;
  return import(url);
}

async function withEnv(envPatch, fn) {
  const keys = Object.keys(envPatch);
  const prev = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    if (envPatch[k] === undefined) delete process.env[k];
    else process.env[k] = String(envPatch[k]);
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

console.log("ai-keys-api-unit-test");

await check("migration SQL is additive-only", async () => {
  const sql = readFileSync(
    join(root, "scripts/migrations/20261110_ai_key_meta_and_audit.sql"),
    "utf8",
  );
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "lastUsedAt"/);
  assert.match(sql, /user_ai_key_audit/);
  assert.doesNotMatch(sql, /DROP TABLE/i);
});

await check("docs list stable error codes", async () => {
  const doc = readFileSync(join(root, "docs/API-AI-KEYS-AND-SKIP.md"), "utf8");
  for (const code of [
    "AI_KEY_UNAUTHORIZED",
    "AI_KEY_NOT_FOUND",
    "AI_KEY_INVALID_ID",
    "AI_KEY_INVALID",
    "AI_KEY_TEST_TIMEOUT",
    "AI_KEY_PROVIDER_AUTH",
    "AI_PROVIDER_TIMEOUT",
    "AI_PROVIDER_RATE_LIMIT",
    "AI_PROVIDER_QUOTA",
    "AI_PROVIDER_UNAVAILABLE",
    "AI_PROVIDER_BAD_REQUEST",
    "AI_PROVIDER_ERROR",
    "FILL_BAD_SKIP",
    "FILL_LIST_NOT_ARRAY",
    "keySource",
    "uploadLimitText",
  ]) {
    assert.match(doc, new RegExp(code));
  }
});

await check("api routes wire create/test/audit/replace + validate-on-save", async () => {
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /api\.get\("\/ai\/keys\/audit"/);
  assert.match(api, /api\.post\("\/ai\/keys"/);
  assert.match(api, /api\.post\("\/ai\/keys\/:id\/test"/);
  assert.match(api, /api\.put\("\/ai\/keys\/:id"/);
  assert.match(api, /api\.post\("\/ai\/key\/test"/);
  assert.match(api, /rejectInvalidAiKey|validateAiKeyForSave/);
  assert.match(api, /uploadLimitText/);
  assert.match(api, /fromUserVault/);
  assert.match(api, /form\.get\("skip"\)/);
});

await check("vault CRUD + ownership + audit + mask (Postgres)", async () => {
  const {
    createUserAiKey,
    replaceUserAiKey,
    deleteUserAiKey,
    getUserAiKey,
    listUserAiKeysPublic,
    listUserAiKeyAudit,
    updateUserAiKeyTestResult,
    toPublicAiKey,
  } = await loadFresh("src/server/ai-key-vault.ts");

  try {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString:
        process.env.DATABASE_URL ||
        "postgres://docx:docx@127.0.0.1:5432/docx_form",
      connectionTimeoutMillis: 1500,
    });
    await client.connect();
    await client.end();
  } catch (err) {
    console.log(
      `⊘ skip vault CRUD (Postgres unavailable: ${err?.code || err?.message || "error"})`,
    );
    return;
  }

  const owner = `keys-owner-${Date.now()}`;
  const other = `keys-other-${Date.now()}`;
  const created = await createUserAiKey(owner, {
    provider: "google",
    label: "unit-key",
    model: "gemini-3.8-flash",
    apiKey: "AIzaSyUnitTestKeyNotRealMASK01",
  });
  assert.ok(created.id);
  assert.match(created.apiKey, /^AIza/);

  const pub = toPublicAiKey(created);
  assert.equal(pub.hasKey, true);
  assert.match(pub.maskedKey, /•/);
  assert.doesNotMatch(pub.maskedKey, /AIzaSyUnit/);
  assert.equal(pub.lastTestStatus, "untested");

  const listed = await listUserAiKeysPublic(owner);
  assert.ok(listed.some((e) => e.id === created.id));
  assert.equal(
    listed.find((e) => e.id === created.id)?.maskedKey,
    pub.maskedKey,
  );

  // Other user cannot see / delete
  assert.equal(await getUserAiKey(other, created.id), null);
  assert.equal(await deleteUserAiKey(other, created.id), false);
  assert.ok(await getUserAiKey(owner, created.id));

  const replaced = await replaceUserAiKey(owner, created.id, {
    apiKey: "AIzaSyUnitTestKeyNotRealMASK02",
    label: "rotated",
  });
  assert.ok(replaced);
  assert.equal(replaced.label, "rotated");
  assert.equal(replaced.apiKey.endsWith("02"), true);

  const afterTest = await updateUserAiKeyTestResult(owner, created.id, {
    ok: false,
    code: "AI_KEY_PROVIDER_AUTH",
    message: "API key หรือสิทธิ์ไม่ถูกต้อง",
  });
  assert.equal(afterTest?.lastTestOk, false);
  assert.equal(afterTest?.lastTestCode, "AI_KEY_PROVIDER_AUTH");
  assert.equal(toPublicAiKey(afterTest).lastTestStatus, "error");

  const audit = await listUserAiKeyAudit(owner, { keyId: created.id, limit: 20 });
  const actions = audit.map((e) => e.action);
  assert.ok(actions.includes("create"));
  assert.ok(actions.includes("replace"));
  assert.ok(actions.includes("test"));
  for (const e of audit) {
    assert.doesNotMatch(String(e.message || ""), /AIzaSy/);
  }

  // Other user's audit is empty for this key
  const otherAudit = await listUserAiKeyAudit(other, { keyId: created.id });
  assert.equal(otherAudit.length, 0);

  assert.equal(await deleteUserAiKey(owner, created.id), true);
  const afterDel = await listUserAiKeyAudit(owner, { keyId: created.id });
  assert.ok(afterDel.some((e) => e.action === "delete"));
});

await check("key test mock ok / 401 / timeout / quota", async () => {
  await withEnv({ DOCX_FORM_AI_KEY_TEST_MOCK: "ok" }, async () => {
    const { testAiProviderKey } = await loadFresh("src/server/ai-key-test.ts");
    const r = await testAiProviderKey({
      provider: "google",
      apiKey: "AIzaSyMockKeyNotReal00000001",
    });
    assert.equal(r.ok, true);
    assert.equal(r.code, "AI_KEY_TEST_OK");
  });
  await withEnv({ DOCX_FORM_AI_KEY_TEST_MOCK: "401" }, async () => {
    const { testAiProviderKey, validateAiKeyForSave, saveRejectCodeFromTest } =
      await loadFresh("src/server/ai-key-test.ts");
    const r = await testAiProviderKey({
      provider: "cursor",
      apiKey: "crsr_mock_bad",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "AI_KEY_INVALID");
    assert.equal(saveRejectCodeFromTest(r), "AI_KEY_INVALID");
    const v = await validateAiKeyForSave({
      provider: "cursor",
      apiKey: "crsr_mock_bad",
    });
    assert.equal(v.ok, false);
    assert.equal(v.code, "AI_KEY_INVALID");
  });
  await withEnv({ DOCX_FORM_AI_KEY_TEST_MOCK: "quota" }, async () => {
    const { testAiProviderKey } = await loadFresh("src/server/ai-key-test.ts");
    const r = await testAiProviderKey({
      provider: "google",
      apiKey: "AIzaSyMockQuota",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "AI_PROVIDER_QUOTA");
  });
  await withEnv({ DOCX_FORM_AI_KEY_TEST_MOCK: "hang" }, async () => {
    const { testAiProviderKey } = await loadFresh("src/server/ai-key-test.ts");
    const t0 = Date.now();
    const r = await testAiProviderKey({
      provider: "google",
      apiKey: "AIzaSyMockHang",
      timeoutMs: 100,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "AI_PROVIDER_TIMEOUT");
    assert.ok(Date.now() - t0 < 3000);
  });
});

if (failed) {
  console.error(`ai-keys-api-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-keys-api-unit-test: ok");
