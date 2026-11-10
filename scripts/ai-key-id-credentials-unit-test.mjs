#!/usr/bin/env node
/**
 * X-Ai-Key-Id resolve, auth fallback to DOCX_FORM_CURSOR_API_KEY,
 * vault ownership delete, model-label resolver, and UI entry wiring.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = process.env;
let failed = 0;

async function withEnv(patch, fn) {
  const prev = {};
  for (const key of Object.keys(patch)) {
    prev[key] = ENV[key];
    const val = patch[key];
    if (val === undefined) delete ENV[key];
    else ENV[key] = val;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (prev[key] === undefined) delete ENV[key];
      else ENV[key] = prev[key];
    }
  }
}

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

function loadFresh(rel) {
  const url = new URL(rel, import.meta.url);
  url.searchParams.set("t", String(Date.now()) + Math.random());
  return import(url.href);
}

console.log("ai-key-id-credentials-unit-test");

await check("api.ts routes use resolveRequestAiCredentials / resolveRouteAiCredentials", async () => {
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /api\.get\("\/diagnostics"/);
  assert.match(api, /api\.post\("\/batch-from-source"/);
  assert.match(api, /api\.post\("\/source-map"/);
  assert.match(api, /api\.post\("\/template\/suggest-tags"/);
  // No leftover header-only getRequestAiCredentials calls for AI routes.
  assert.doesNotMatch(api, /getRequestAiCredentials\(/);
  assert.match(api, /resolveRouteAiCredentials/);
  assert.match(api, /runWithSavedAiKeyAuthFallback/);
  assert.match(api, /coalesceAiCredentialsWithSharedEnv/);
  assert.match(api, /api\.delete\("\/ai\/keys\/:id"/);
  assert.match(api, /api\.delete\("\/admin\/ai\/server-key"/);
});

await check("shared dialog + account + pill wiring present", async () => {
  const dialog = readFileSync(join(root, "public/ai-key-dialog.js"), "utf8");
  const shim = readFileSync(join(root, "public/ai-keys-dialog.js"), "utf8");
  const app = readFileSync(join(root, "public/app.js"), "utf8");
  const account = readFileSync(join(root, "src/app/account/page.tsx"), "utf8");
  const section = readFileSync(join(root, "src/components/AiKeysSection.tsx"), "utf8");
  const admin = readFileSync(join(root, "src/app/admin/ai/page.tsx"), "utf8");
  assert.match(dialog, /export async function openAiKeyDialog/);
  assert.match(dialog, /export async function openAiKeysDialog/);
  assert.match(dialog, /ลบคีย์นี้\?/);
  assert.match(dialog, /ลบคีย์/);
  assert.match(shim, /from "\.\/ai-key-dialog\.js"/);
  assert.match(app, /from "\.\/ai-key-dialog\.js"/);
  assert.match(app, /bindStatusPillAiKeysOpener/);
  assert.match(app, /openSharedAiKeysDialog|openAiKeyDialog/);
  assert.match(app, /coerceClientAiModel/);
  assert.match(account, /AiKeysSection/);
  assert.match(section, /openAiKeysDialog/);
  assert.match(section, /ai-key-dialog\.js/);
  assert.match(admin, /set via server/);
  assert.match(admin, /\/api\/admin\/ai\/server-key/);
});

await check("resolveEffectiveModelForProvider remaps gemini id under cursor", async () => {
  const { resolveEffectiveModelForProvider } = await loadFresh(
    "../src/server/ai-providers.ts",
  );
  assert.equal(
    resolveEffectiveModelForProvider("cursor", "gemini-3.8-flash"),
    "composer-2.5",
  );
  assert.equal(resolveEffectiveModelForProvider("cursor", "composer-2.5"), "composer-2.5");
  assert.equal(resolveEffectiveModelForProvider("google", "gemini-3.8-flash"), "gemini-3.8-flash");
});

await check("geminiStatus pill model matches effective cursor model", async () => {
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_shared_server_key_abcdefgh",
    },
    async () => {
      const { geminiStatus } = await loadFresh("../src/server/ai-config.ts");
      const status = geminiStatus({
        requestProvider: "google",
        requestModel: "gemini-3.8-flash",
        adminDefaultModel: "gemini-3.8-flash",
        adminDefaultProvider: "google",
      });
      assert.equal(status.effectiveProvider, "cursor");
      assert.equal(status.model, "composer-2.5");
      assert.notEqual(status.model, "gemini-3.8-flash");
    },
  );
});

await check("auth fallback retries once with shared env key", async () => {
  await withEnv(
    {
      DOCX_FORM_CURSOR_API_KEY: "crsr_shared_fallback_key_zzzz",
    },
    async () => {
      const {
        runWithSavedAiKeyAuthFallback,
        peekSharedCursorEnvApiKey,
        formatSavedAiKeyAuthError,
      } = await loadFresh("../src/server/ai-config.ts");
      assert.equal(peekSharedCursorEnvApiKey(), "crsr_shared_fallback_key_zzzz");

      let calls = 0;
      const result = await runWithSavedAiKeyAuthFallback(
        {
          provider: "google",
          apiKey: "bad-user-key",
          model: "gemini-3.8-flash",
          fromUserVault: true,
          keyId: "k-test-1",
          keyLabel: "งานทดสอบ",
        },
        async (effective) => {
          calls += 1;
          if (calls === 1) {
            const err = new Error("Google AI: API key หรือสิทธิ์ไม่ถูกต้อง");
            err.status = 401;
            throw err;
          }
          assert.equal(effective.provider, "cursor");
          assert.equal(effective.apiKey, "crsr_shared_fallback_key_zzzz");
          return { ok: true };
        },
      );
      assert.equal(calls, 2);
      assert.equal(result.ok, true);

      // Non-auth errors must not fall back.
      let nonAuthCalls = 0;
      await assert.rejects(
        () =>
          runWithSavedAiKeyAuthFallback(
            {
              provider: "google",
              apiKey: "bad-user-key",
              model: "gemini-3.8-flash",
              fromUserVault: true,
              keyId: "k-test-1",
              keyLabel: "งานทดสอบ",
            },
            async () => {
              nonAuthCalls += 1;
              throw new Error("Google AI: เกินโควต้าแล้ว");
            },
          ),
        /เกินโควต้า/,
      );
      assert.equal(nonAuthCalls, 1);

      const msg = formatSavedAiKeyAuthError({
        keyId: "k-test-1",
        label: "งานทดสอบ",
      });
      assert.match(msg, /งานทดสอบ/);
      assert.match(msg, /k-test-1/);
      assert.doesNotMatch(msg, /bad-user-key|crsr_shared/);
    },
  );
});

await check("invalid user key without env returns clear named error", async () => {
  await withEnv({ DOCX_FORM_CURSOR_API_KEY: undefined }, async () => {
    const { runWithSavedAiKeyAuthFallback, peekSharedCursorEnvApiKey } =
      await loadFresh("../src/server/ai-config.ts");
    assert.equal(peekSharedCursorEnvApiKey(), undefined);
    await assert.rejects(
      () =>
        runWithSavedAiKeyAuthFallback(
          {
            provider: "cursor",
            apiKey: "crsr_bad",
            model: "composer-2.5",
            fromUserVault: true,
            keyId: "k-gone",
            keyLabel: "คีย์เก่า",
          },
          async () => {
            const err = new Error("Cursor: API key ไม่ถูกต้องหรือหมดอายุ");
            throw err;
          },
        ),
      /คีย์เก่า|k-gone|ถูกปฏิเสธ/,
    );
  });
});

await check("missing vault key error / coalesce to shared env", async () => {
  await withEnv(
    { DOCX_FORM_CURSOR_API_KEY: "crsr_shared_only_abcdef" },
    async () => {
      const {
        coalesceAiCredentialsWithSharedEnv,
        missingAiCredentialsError,
        formatMissingVaultAiKeyError,
      } = await loadFresh("../src/server/ai-config.ts");
      const missing = {
        provider: "google",
        requestedKeyId: "k-deleted",
        fromUserVault: false,
      };
      assert.match(missingAiCredentialsError(missing), /k-deleted/);
      assert.match(formatMissingVaultAiKeyError({ keyId: "k-deleted" }), /k-deleted/);
      const coalesced = coalesceAiCredentialsWithSharedEnv(missing);
      assert.equal(coalesced.usedSharedEnvFallback, true);
      assert.equal(coalesced.provider, "cursor");
      assert.equal(coalesced.apiKey, "crsr_shared_only_abcdef");
    },
  );
});

await check("isAiCredentialAuthError detects auth only", async () => {
  const { isAiCredentialAuthError } = await loadFresh(
    "../src/server/ai-http-errors.ts",
  );
  assert.equal(isAiCredentialAuthError(new Error("unauthorized")), true);
  assert.equal(isAiCredentialAuthError(new Error("API key ไม่ถูกต้องหรือหมดอายุ")), true);
  assert.equal(isAiCredentialAuthError(new Error("เกินโควต้าแล้ว")), false);
  const e401 = new Error("fail");
  e401.status = 401;
  assert.equal(isAiCredentialAuthError(e401), true);
});

await check("vault delete ownership + id validation (local Postgres)", async () => {
  ENV.DATABASE_URL =
    ENV.DATABASE_URL || "postgres://docx:docx@127.0.0.1:5432/docx_form";
  ENV.BETTER_AUTH_SECRET = ENV.BETTER_AUTH_SECRET || "unit-test-secret-32chars-min!!!!";
  const {
    upsertUserAiKey,
    deleteUserAiKey,
    getUserAiKey,
    isValidUserAiKeyId,
    listUserAiKeys,
  } = await loadFresh("../src/server/ai-key-vault.ts");

  assert.equal(isValidUserAiKeyId("k-abc-1"), true);
  assert.equal(isValidUserAiKeyId("../etc/passwd"), false);
  assert.equal(isValidUserAiKeyId(""), false);

  const owner = "unit-owner-" + Date.now();
  const other = "unit-other-" + Date.now();
  const id = `k-unit-${Date.now().toString(36)}`;
  await upsertUserAiKey(owner, {
    id,
    provider: "google",
    label: "unit",
    model: "gemini-3.8-flash",
    apiKey: "AIzaSyUnitTestKeyNotReal0001",
  });
  assert.ok(await getUserAiKey(owner, id));

  // Other user cannot delete → false (API maps to 404).
  assert.equal(await deleteUserAiKey(other, id), false);
  assert.ok(await getUserAiKey(owner, id), "row must remain after cross-user delete");

  assert.equal(await deleteUserAiKey(owner, id), true);
  assert.equal(await getUserAiKey(owner, id), null);
  const left = await listUserAiKeys(owner);
  assert.equal(left.find((e) => e.id === id), undefined);
});

await check("admin env key never exposes value in page source", async () => {
  const admin = readFileSync(join(root, "src/app/admin/ai/page.tsx"), "utf8");
  assert.match(admin, /set via server/);
  assert.doesNotMatch(admin, /DOCX_FORM_CURSOR_API_KEY\s*\+/);
  assert.doesNotMatch(admin, /process\.env/);
});

if (failed) {
  console.error(`ai-key-id-credentials-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-key-id-credentials-unit-test: ok");
