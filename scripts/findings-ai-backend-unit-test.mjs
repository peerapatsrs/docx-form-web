#!/usr/bin/env node
/**
 * FINDINGS Backend unit coverage:
 * F30 validate-on-save, F27/F28/F07 shared error mapper,
 * F18 admin sanitization + effective model, F31/F19 keySource status, F02 plan quota.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

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

console.log("findings-ai-backend-unit-test");

await check("F27/F28/F07 classifyProviderError stable codes + no default credits", async () => {
  const { classifyProviderError, formatProviderHttpError, formatModelsListError } =
    await loadFresh("src/server/ai-http-errors.ts");

  const auth = classifyProviderError({
    providerLabel: "Google AI",
    status: 400,
    body: JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }),
  });
  assert.equal(auth.code, "AI_KEY_INVALID");
  assert.doesNotMatch(auth.message, /เครดิต|โควต้า|credits/i);

  const rate = classifyProviderError({
    providerLabel: "OpenAI",
    status: 429,
    body: "Too Many Requests",
  });
  assert.equal(rate.code, "AI_PROVIDER_RATE_LIMIT");
  assert.doesNotMatch(rate.message, /เครดิต|โควต้าหมด/);

  const quota = classifyProviderError({
    providerLabel: "DeepSeek",
    status: 402,
    body: JSON.stringify({ error: { message: "Insufficient Balance" } }),
  });
  assert.equal(quota.code, "AI_PROVIDER_QUOTA");
  assert.match(quota.message, /เครดิต|โควต้า/);

  const timeout = classifyProviderError({
    providerLabel: "Cursor",
    err: new Error("AI_TIMEOUT"),
  });
  assert.equal(timeout.code, "AI_PROVIDER_TIMEOUT");

  const unavailable = classifyProviderError({
    providerLabel: "Anthropic",
    status: 503,
    body: "overloaded",
  });
  assert.equal(unavailable.code, "AI_PROVIDER_UNAVAILABLE");

  const badReq = classifyProviderError({
    providerLabel: "OpenAI",
    status: 400,
    body: JSON.stringify({ error: { message: "model does not exist" } }),
  });
  assert.equal(badReq.code, "AI_PROVIDER_BAD_REQUEST");

  // Models list uses same mapper — invalid key must not blame credits (F27).
  const modelsMsg = formatModelsListError(
    "Google Gemini",
    400,
    JSON.stringify({ error: { message: "API key not valid" } }),
  );
  assert.match(modelsMsg, /คีย์|สิทธิ์/);
  assert.doesNotMatch(modelsMsg, /เครดิต/);

  const httpMsg = formatProviderHttpError("Google AI", 401, "Unauthorized");
  assert.match(httpMsg, /API key หรือสิทธิ์ไม่ถูกต้อง/);
  assert.doesNotMatch(httpMsg, /เครดิต/);
});

await check("F30 validateAiKeyForSave rejects invalid and maps AI_KEY_INVALID", async () => {
  await withEnv({ DOCX_FORM_AI_KEY_TEST_MOCK: "401" }, async () => {
    const { validateAiKeyForSave } = await loadFresh("src/server/ai-key-test.ts");
    const r = await validateAiKeyForSave({
      provider: "cursor",
      apiKey: "crsr_fake_000",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "AI_KEY_INVALID");
  });
  await withEnv({ DOCX_FORM_AI_KEY_TEST_MOCK: "ok" }, async () => {
    const { validateAiKeyForSave } = await loadFresh("src/server/ai-key-test.ts");
    const r = await validateAiKeyForSave({
      provider: "google",
      apiKey: "AIzaSyMockKeyNotReal00000001",
    });
    assert.equal(r.ok, true);
    assert.equal(r.code, "AI_KEY_TEST_OK");
  });
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /rejectInvalidAiKey/);
  // create + put + rotate all call the probe
  assert.match(api, /api\.post\("\/ai\/keys"[\s\S]*?rejectInvalidAiKey/);
  assert.match(api, /api\.put\("\/ai\/keys"[\s\S]*?rejectInvalidAiKey/);
  assert.match(api, /api\.put\("\/ai\/keys\/:id"[\s\S]*?rejectInvalidAiKey/);
});

await check("F18 geminiStatus has no configPath / env names; effective model agrees", async () => {
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_shared_status_test_abcdef",
      DOCX_FORM_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      PREMIUM_ENFORCE: "0",
    },
    async () => {
      const { geminiStatus } = await loadFresh("src/server/ai-config.ts");
      const status = geminiStatus({
        adminDefaultModel: "gemini-3.8-flash",
        adminDefaultProvider: "google",
      });
      assert.equal("configPath" in status, false);
      assert.ok(status.configStoreLabel);
      assert.doesNotMatch(String(status.configStoreLabel), /\/tmp\/|config\.json/);
      assert.equal(status.serverEnvCursorKeySource, "set via server");
      assert.equal(status.effectiveModel, status.model);
      // With Cursor shared key, effective provider should be cursor and model
      // should NOT stay as the Gemini admin default.
      assert.equal(status.effectiveProvider, "cursor");
      assert.doesNotMatch(String(status.model), /^gemini-/i);
      assert.equal(status.keySource, "shared");
    },
  );

  const adminPage = readFileSync(join(root, "src/app/admin/ai/page.tsx"), "utf8");
  assert.doesNotMatch(adminPage, /DOCX_FORM_CURSOR_API_KEY/);
  assert.doesNotMatch(adminPage, /PREMIUM_ENFORCE/);
  assert.doesNotMatch(adminPage, /configPath/);
  assert.match(adminPage, /effectiveModel|โมเดลที่ใช้จริง/);
  assert.match(adminPage, /set via server/);
});

await check("F31/F19 status exposes keySource user|shared|none + lastTest", async () => {
  const { geminiStatus } = await loadFresh("src/server/ai-config.ts");
  const none = geminiStatus({});
  assert.ok(["user", "shared", "none"].includes(none.keySource));

  const user = geminiStatus({
    requestKey: "AIzaSyUserKeyNotReal000000001",
    requestProvider: "google",
    fromUserVault: true,
    keyId: "k-user-1",
    lastTestOk: true,
    lastTestCode: "AI_KEY_TEST_OK",
    lastTestAt: "2026-11-10T00:00:00.000Z",
  });
  assert.equal(user.keySource, "user");
  assert.equal(user.keyId, "k-user-1");
  assert.equal(user.lastTestStatus, "ok");
  assert.equal(user.lastTestOk, true);

  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /fromUserVault/);
  assert.match(api, /lastTestOk/);
  assert.match(api, /coalesceAiCredentialsWithSharedEnv/);
  assert.match(api, /\/ai\/status/);
  const statusSrc = readFileSync(join(root, "src/server/ai-config.ts"), "utf8");
  assert.match(statusSrc, /keySource/);
  assert.match(statusSrc, /lastTestStatus/);
});

await check("F02 entitlement uploadLimitText + client plan-aware dropzone", async () => {
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /uploadLimitText/);
  assert.match(api, /getAppLimits/);

  const app = readFileSync(join(root, "public/app.js"), "utf8");
  assert.match(app, /dropzoneOrPickLabel/);
  assert.match(app, /getMaxMultiTemplates\(\)/);
  assert.doesNotMatch(app, /ฟรีสูงสุด 2 ไฟล์ต่อครั้ง/);

  const labels = readFileSync(join(root, "public/ui-labels.js"), "utf8");
  assert.doesNotMatch(labels, /ฟรีสูงสุด 2 ไฟล์ต่อครั้ง/);
});

await check("docs document every new provider error code", async () => {
  const doc = readFileSync(join(root, "docs/API-AI-KEYS-AND-SKIP.md"), "utf8");
  for (const code of [
    "AI_KEY_INVALID",
    "AI_PROVIDER_RATE_LIMIT",
    "AI_PROVIDER_QUOTA",
    "AI_PROVIDER_TIMEOUT",
    "AI_PROVIDER_UNAVAILABLE",
    "AI_PROVIDER_BAD_REQUEST",
    "AI_PROVIDER_ERROR",
    "AI_PROVIDER_AUTH",
    "keySource",
    "effectiveModel",
    "uploadLimitText",
  ]) {
    assert.match(doc, new RegExp(code));
  }
});

if (failed) {
  console.error(`findings-ai-backend-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("findings-ai-backend-unit-test: ok");
