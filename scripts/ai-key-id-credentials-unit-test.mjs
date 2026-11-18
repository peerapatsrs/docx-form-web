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
  // Diagnostics must coalesce shared keys the same way as /ai/status.
  const diagIdx = api.indexOf('api.get("/diagnostics"');
  const diagSlice = api.slice(diagIdx, diagIdx + 900);
  assert.match(diagSlice, /coalesceAiCredentialsWithSharedEnv/);
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
  // FE tip opens the dialog via openAiKeyDialog (pill / googleAiBtn), not the old binder name.
  assert.match(app, /openAiKeyDialog|openAiKeysManager|bindStatusPillAiKeysOpener/);
  assert.match(app, /googleAiBtn/);
  // Shared-key ready when BYOK off: trust server connected / keySource=shared.
  assert.match(app, /!!data\.connected/);
  assert.match(app, /aiStatus\.keySource === "shared"/);
  assert.match(app, /คีย์เซิร์ฟเวอร์/);
  // Attach button must enable for shared/server key (not personal-only).
  assert.match(app, /function hasSharedServerAiCredentials/);
  assert.match(app, /function hasUsableAiCredentials/);
  assert.match(app, /const aiReady = hasUsableAiCredentials\(\)/);
  assert.match(app, /attachSource[\s\S]{0,200}hasUsableAiCredentials|hasUsableAiCredentials[\s\S]{0,80}attachSourceNeedKeyBanner/);
  assert.match(account, /AiKeysSection/);
  // Account settings: server vs BYOK radio cards via adapter (no system key values).
  assert.match(section, /ai-key-settings-adapter/);
  assert.match(section, /ใช้คีย์กลางของระบบ|modeServer/);
  assert.match(section, /ใช้คีย์ของฉันเอง|modeByok/);
  assert.match(admin, /serverKeySources/);
  assert.match(admin, /ไม่ได้ตั้งค่าคีย์เซิร์ฟเวอร์/);
  assert.match(admin, /\/api\/admin\/ai\/server-key/);
  // No provider-specific server-key row labels in the admin UI.
  assert.doesNotMatch(admin, /คีย์ Gemini ของเซิร์ฟเวอร์/);
  assert.doesNotMatch(admin, /คีย์ Gemini บนเซิร์ฟเวอร์ \(ไฟล์\)/);
  assert.doesNotMatch(admin, /คีย์ Cursor ของเซิร์ฟเวอร์/);
});

await check("shared server key auth error + health configured flag", async () => {
  const {
    hasServerAiKeyConfigured,
    formatSharedServerKeyAuthError,
    geminiStatus,
  } = await loadFresh("../src/server/ai-config.ts");
  const { aiProviderErrorJsonBody } = await loadFresh(
    "../src/server/ai-request.ts",
  );

  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_shared_health_flag_abcdef",
    },
    async () => {
      assert.equal(hasServerAiKeyConfigured(), true);
      const status = geminiStatus({});
      assert.equal(status.serverAiKeyConfigured, true);
      assert.equal(status.keySource, "shared");
    },
  );

  await withEnv({ DOCX_FORM_BYOK_ONLY: "1" }, async () => {
    delete process.env.DOCX_FORM_CURSOR_API_KEY;
    delete process.env.DOCX_FORM_GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    assert.equal(hasServerAiKeyConfigured(), false);
  });

  const msg = formatSharedServerKeyAuthError("Cursor");
  assert.match(msg, /คีย์เซิร์ฟเวอร์/);
  assert.match(msg, /ไม่ใช่คีย์ส่วนตัว/);
  assert.doesNotMatch(msg, /crsr_|AIza|DOCX_FORM_CURSOR/);

  const body = aiProviderErrorJsonBody(new Error("Invalid User API Key"), {
    usedSharedEnvFallback: true,
    keySource: "shared",
    providerLabel: "Cursor",
  });
  assert.equal(body.code, "AI_SERVER_KEY_INVALID");
  assert.match(body.error, /คีย์เซิร์ฟเวอร์/);
  assert.doesNotMatch(body.error, /crsr_|DOCX_FORM/);

  const personal = aiProviderErrorJsonBody(new Error("Invalid User API Key"), {
    usedSharedEnvFallback: false,
  });
  assert.equal(personal.code, "AI_AUTH");

  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /serverAiKeyConfigured/);
  assert.match(api, /hasServerAiKeyConfigured/);
  assert.match(api, /AI_SERVER_KEY_INVALID|sharedServerKeyErrorOpts/);

  const client = readFileSync(join(root, "public/ai-key-client.js"), "utf8");
  assert.match(client, /AI_SERVER_KEY_INVALID/);
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

await check("BYOK_ONLY=0 coalesces shared key with no personal key / no keyId", async () => {
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_shared_any_user_abcdef",
      DOCX_FORM_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    },
    async () => {
      const {
        coalesceAiCredentialsWithSharedEnv,
        geminiStatus,
        resolveEffectiveAiProvider,
        resolveProviderApiKey,
        isByokOnly,
        getGeminiApiKey,
      } = await loadFresh("../src/server/ai-config.ts");
      assert.equal(isByokOnly(), false);
      const empty = {
        provider: "google",
        apiKey: "",
        model: "",
        fromUserVault: false,
      };
      const coalesced = coalesceAiCredentialsWithSharedEnv(empty);
      assert.equal(coalesced.usedSharedEnvFallback, true);
      assert.equal(coalesced.provider, "cursor");
      assert.equal(coalesced.apiKey, "crsr_shared_any_user_abcdef");
      // Cursor key must NOT masquerade as a Gemini key.
      assert.equal(getGeminiApiKey(coalesced.apiKey), undefined);
      const provider = resolveEffectiveAiProvider({
        requestProvider: coalesced.provider,
        requestKey: coalesced.apiKey,
        adminDefaultProvider: "google",
      });
      assert.equal(provider, "cursor");
      assert.equal(
        resolveProviderApiKey(provider, coalesced.apiKey),
        "crsr_shared_any_user_abcdef",
      );
      const status = geminiStatus({
        requestKey: coalesced.apiKey,
        requestProvider: coalesced.provider,
        usedSharedEnvFallback: true,
        adminDefaultProvider: "google",
      });
      assert.equal(status.connected, true);
      assert.equal(status.keySource, "shared");
      assert.equal(status.byok, false);
      assert.equal(status.effectiveProvider, "cursor");
      assert.equal(status.provider, "cursor");
      assert.notEqual(status.model, "gemini-3.8-flash");
    },
  );
});

await check("shared key resolution: cursor-only / google-only / both", async () => {
  // Cursor only → effective cursor even when admin default is google.
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_only_shared_abcdefgh",
      DOCX_FORM_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    },
    async () => {
      const {
        coalesceAiCredentialsWithSharedEnv,
        resolveEffectiveAiProvider,
        geminiStatus,
      } = await loadFresh("../src/server/ai-config.ts");
      const c = coalesceAiCredentialsWithSharedEnv({
        provider: "google",
        apiKey: "",
        fromUserVault: false,
      });
      assert.equal(c.provider, "cursor");
      assert.equal(
        resolveEffectiveAiProvider({
          requestProvider: c.provider,
          requestKey: c.apiKey,
          adminDefaultProvider: "google",
        }),
        "cursor",
      );
      const st = geminiStatus({
        requestKey: c.apiKey,
        requestProvider: c.provider,
        usedSharedEnvFallback: true,
        adminDefaultProvider: "google",
      });
      assert.equal(st.effectiveProvider, "cursor");
      assert.equal(st.keySource, "shared");
    },
  );

  // Google only → effective google.
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: undefined,
      DOCX_FORM_GEMINI_API_KEY: "AIzaSyGoogleSharedOnlyKey000001",
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    },
    async () => {
      const {
        coalesceAiCredentialsWithSharedEnv,
        resolveEffectiveAiProvider,
        geminiStatus,
      } = await loadFresh("../src/server/ai-config.ts");
      const c = coalesceAiCredentialsWithSharedEnv({
        provider: "google",
        apiKey: "",
        fromUserVault: false,
      });
      assert.equal(c.provider, "google");
      assert.equal(
        resolveEffectiveAiProvider({
          requestProvider: c.provider,
          requestKey: c.apiKey,
          adminDefaultProvider: "google",
        }),
        "google",
      );
      const st = geminiStatus({
        requestKey: c.apiKey,
        requestProvider: c.provider,
        usedSharedEnvFallback: true,
        adminDefaultProvider: "google",
      });
      assert.equal(st.effectiveProvider, "google");
      assert.equal(st.keySource, "shared");
    },
  );

  // Both → admin default google wins when its env key is usable; Cursor key
  // must not be treated as a Gemini override (calls use the Google env key).
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_both_shared_abcdefgh",
      DOCX_FORM_GEMINI_API_KEY: "AIzaSyGoogleBothSharedKey0000001",
    },
    async () => {
      const {
        coalesceAiCredentialsWithSharedEnv,
        resolveEffectiveAiProvider,
        resolveProviderApiKey,
        getGeminiApiKey,
        geminiStatus,
      } = await loadFresh("../src/server/ai-config.ts");
      const c = coalesceAiCredentialsWithSharedEnv({
        provider: "google",
        apiKey: "",
        fromUserVault: false,
      });
      assert.equal(c.provider, "cursor");
      assert.equal(getGeminiApiKey(c.apiKey), "AIzaSyGoogleBothSharedKey0000001");
      assert.equal(
        resolveEffectiveAiProvider({
          requestProvider: c.provider,
          requestKey: c.apiKey,
          adminDefaultProvider: "google",
        }),
        "google",
      );
      assert.equal(
        resolveProviderApiKey("google", c.apiKey),
        "AIzaSyGoogleBothSharedKey0000001",
      );
      const st = geminiStatus({
        requestKey: c.apiKey,
        requestProvider: c.provider,
        usedSharedEnvFallback: true,
        adminDefaultProvider: "google",
      });
      assert.equal(st.effectiveProvider, "google");
      assert.equal(st.keySource, "shared");
    },
  );
});

await check("BYOK_ONLY=1 does not coalesce shared key without keyId", async () => {
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "1",
      DOCX_FORM_CURSOR_API_KEY: "crsr_shared_blocked_by_byok_xx",
    },
    async () => {
      const { coalesceAiCredentialsWithSharedEnv, geminiStatus, isByokOnly } =
        await loadFresh("../src/server/ai-config.ts");
      assert.equal(isByokOnly(), true);
      const empty = {
        provider: "google",
        apiKey: "",
        model: "",
        fromUserVault: false,
      };
      const coalesced = coalesceAiCredentialsWithSharedEnv(empty);
      assert.equal(coalesced.usedSharedEnvFallback, undefined);
      assert.equal(Boolean(coalesced.apiKey), false);
      const status = geminiStatus({
        requestKey: coalesced.apiKey,
        requestProvider: coalesced.provider,
        adminDefaultProvider: "google",
      });
      assert.equal(status.connected, false);
      assert.equal(status.keySource, "none");
      assert.equal(status.byok, true);
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

  // Reachability probe — skip quietly when CI has no Postgres (unit suite is mostly offline).
  try {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: ENV.DATABASE_URL,
      connectionTimeoutMillis: 1500,
    });
    await client.connect();
    await client.end();
  } catch (err) {
    console.log(
      `⊘ skip vault ownership (Postgres unavailable: ${err?.code || err?.message || "error"})`,
    );
    return;
  }

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
