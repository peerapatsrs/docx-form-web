#!/usr/bin/env node
/**
 * AI key choice: canUseAi gate, status fields, models-by-source,
 * fill source override validation.
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

console.log("ai-key-choice-unit-test");

await check("routes: GET/PUT status + GET models + fill source", async () => {
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /api\.get\("\/ai\/keys\/status"/);
  assert.match(api, /api\.put\("\/ai\/keys\/status"/);
  assert.match(api, /api\.get\("\/ai\/keys\/models"/);
  assert.match(api, /listAiModelsForChoice/);
  assert.match(api, /validateModelForSource/);
  assert.match(api, /source: formSource/);
  assert.match(api, /buildAiKeyChoiceStatus/);
  // Registered before :id so path is not captured as id.
  const statusIdx = api.indexOf('api.get("/ai/keys/status"');
  const modelsIdx = api.indexOf('api.get("/ai/keys/models"');
  const idIdx = api.indexOf('api.get("/ai/keys/:id"');
  assert.ok(statusIdx > 0 && modelsIdx > 0 && idIdx > 0);
  assert.ok(statusIdx < idIdx && modelsIdx < idIdx);
});

await check("client canUseAi mirrors server + app gate wiring", async () => {
  const client = await loadFresh("../public/ai-key-choice.js");
  assert.equal(
    client.canUseAi({
      mode: "server",
      serverKeyAvailable: true,
      userKeySet: false,
    }),
    true,
  );
  assert.equal(
    client.canUseAi({
      mode: "server",
      serverKeyAvailable: false,
      userKeySet: true,
    }),
    false,
  );
  assert.equal(
    client.canUseAi({
      mode: "byok",
      serverKeyAvailable: true,
      userKeySet: true,
    }),
    true,
  );
  assert.equal(
    client.canUseAi({
      mode: "byok",
      serverKeyAvailable: true,
      userKeySet: false,
    }),
    false,
  );
  assert.equal(client.normalizeAiKeyMode("SERVER"), "server");
  assert.equal(client.normalizeAiKeyMode("byok"), "byok");
  assert.equal(client.normalizeAiKeyMode("other"), null);

  const app = readFileSync(join(root, "public/app.js"), "utf8");
  assert.match(app, /from "\.\/ai-key-choice\.js"/);
  assert.match(app, /canUseAi\(aiKeyChoiceStatus\)/);
  assert.match(app, /\/api\/ai\/keys\/status/);
  assert.match(app, /refreshAiKeyChoiceStatus/);
});

await check("server canUseAi + resolveFillCredentialPolicy + hint", async () => {
  const {
    canUseAi,
    resolveFillCredentialPolicy,
    formatUserKeyHint,
    normalizeAiKeyMode,
  } = await loadFresh("../src/server/ai-key-choice.ts");

  assert.equal(
    canUseAi({ mode: "server", serverKeyAvailable: true, userKeySet: false }),
    true,
  );
  assert.equal(
    canUseAi({ mode: "server", serverKeyAvailable: false, userKeySet: true }),
    false,
  );
  assert.equal(
    canUseAi({ mode: "byok", serverKeyAvailable: false, userKeySet: true }),
    true,
  );
  assert.equal(
    canUseAi({ mode: "byok", serverKeyAvailable: true, userKeySet: false }),
    false,
  );

  const base = {
    mode: "server",
    serverKeyAvailable: true,
    userKeySet: true,
  };
  assert.equal(resolveFillCredentialPolicy(base), "server");
  assert.equal(resolveFillCredentialPolicy(base, "byok"), "byok");
  assert.equal(
    resolveFillCredentialPolicy(
      { ...base, serverKeyAvailable: false },
      "server",
    ),
    "none",
  );
  assert.equal(normalizeAiKeyMode("byok"), "byok");
  assert.equal(formatUserKeyHint("abcd1234"), "••••1234");
  assert.doesNotMatch(formatUserKeyHint("secret-key-9999") || "", /secret-key/);
});

await check("listAiModelsForChoice tags source from catalog", async () => {
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_unit_choice_key_abcdefghij",
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    },
    async () => {
      const {
        listAiModelsForChoice,
        validateModelForSource,
        isServerKeyAvailable,
        userProvidersFromKeys,
      } = await loadFresh("../src/server/ai-key-choice.ts");
      assert.equal(isServerKeyAvailable(), true);

      const googleOnly = userProvidersFromKeys([{ provider: "google" }]);
      assert.deepEqual(googleOnly, ["google"]);

      const both = listAiModelsForChoice(
        {
          mode: "server",
          serverKeyAvailable: true,
          userKeySet: true,
        },
        { userProviders: ["google"] },
      );
      assert.ok(both.some((m) => m.source === "server"));
      assert.ok(both.some((m) => m.source === "byok"));
      assert.ok(both.filter((m) => m.source === "byok").every((m) => m.provider === "google"));
      for (const m of both) {
        assert.ok(m.id && m.label && m.provider);
        assert.ok(m.source === "server" || m.source === "byok");
      }
      // Derived from provider catalog — cursor models under server when Cursor key set.
      assert.ok(
        both.some(
          (m) => m.source === "server" && m.provider === "cursor",
        ),
      );

      const serverOnly = listAiModelsForChoice({
        mode: "server",
        serverKeyAvailable: true,
        userKeySet: false,
      });
      assert.ok(serverOnly.every((m) => m.source === "server"));
      assert.ok(serverOnly.length > 0);

      const byokOnly = listAiModelsForChoice(
        {
          mode: "byok",
          serverKeyAvailable: false,
          userKeySet: true,
        },
        { userProviders: ["google"] },
      );
      assert.ok(byokOnly.every((m) => m.source === "byok" && m.provider === "google"));
      assert.ok(byokOnly.length > 0);
      // Whole catalog must NOT appear for a Google-only vault.
      assert.equal(
        byokOnly.some((m) => m.provider === "openai" || m.provider === "cursor"),
        false,
      );

      const none = listAiModelsForChoice({
        mode: "byok",
        serverKeyAvailable: false,
        userKeySet: false,
      });
      assert.equal(none.length, 0);

      // userKeySet but no providers passed → no BYOK models.
      assert.equal(
        listAiModelsForChoice(
          { mode: "byok", serverKeyAvailable: false, userKeySet: true },
          { userProviders: [] },
        ).length,
        0,
      );

      const ok = validateModelForSource({
        status: {
          mode: "server",
          serverKeyAvailable: true,
          userKeySet: false,
        },
        source: "server",
        model: serverOnly[0].id,
        provider: serverOnly[0].provider,
      });
      assert.equal(ok.ok, true);

      const mismatch = validateModelForSource({
        status: {
          mode: "byok",
          serverKeyAvailable: true,
          userKeySet: true,
        },
        source: "byok",
        model: "gpt-4.1-mini",
        provider: "openai",
        userProviders: ["google"],
      });
      assert.equal(mismatch.ok, false);
      assert.equal(mismatch.code, "AI_MODEL_SOURCE_MISMATCH");

      const googleOk = validateModelForSource({
        status: {
          mode: "byok",
          serverKeyAvailable: false,
          userKeySet: true,
        },
        source: "byok",
        model: byokOnly[0].id,
        provider: "google",
        userProviders: ["google"],
      });
      assert.equal(googleOk.ok, true);

      const noKey = validateModelForSource({
        status: {
          mode: "server",
          serverKeyAvailable: false,
          userKeySet: true,
        },
        source: "server",
        model: "composer-2.5",
      });
      assert.equal(noKey.ok, false);
      assert.equal(noKey.code, "AI_SERVER_KEY_UNAVAILABLE");
      assert.ok(noKey.status >= 400 && noKey.status < 500);

      const missingByok = validateModelForSource({
        status: {
          mode: "byok",
          serverKeyAvailable: true,
          userKeySet: false,
        },
        source: "byok",
      });
      assert.equal(missingByok.ok, false);
      assert.equal(missingByok.code, "AI_KEY_REQUIRED");
      assert.equal(missingByok.status, 400);
    },
  );
});

await check("BYOK-only hides server models", async () => {
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "1",
      DOCX_FORM_CURSOR_API_KEY: "crsr_should_be_ignored_for_server_list",
    },
    async () => {
      const { listAiModelsForChoice, isServerKeyAvailable } = await loadFresh(
        "../src/server/ai-key-choice.ts",
      );
      assert.equal(isServerKeyAvailable(), false);
      const models = listAiModelsForChoice(
        {
          mode: "byok",
          serverKeyAvailable: false,
          userKeySet: true,
        },
        { userProviders: ["google"] },
      );
      assert.ok(models.every((m) => m.source === "byok" && m.provider === "google"));
      assert.equal(
        listAiModelsForChoice({
          mode: "server",
          serverKeyAvailable: false,
          userKeySet: false,
        }).length,
        0,
      );
    },
  );
});

await check("api.ts: AI_KEY_REQUIRED 400 + status unauthorized + deleteKey docs", async () => {
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /code:\s*["']AI_KEY_UNAUTHORIZED["']/);
  assert.match(api, /AI_KEY_REQUIRED/);
  assert.match(api, /deleteKey: true.*all|removes \*\*all\*\*|all of the user's vault keys/i);
  assert.match(api, /userKeyHint.*first saved|first saved vault key/i);
  assert.doesNotMatch(api, /resolveProviderApiKey/);
  assert.match(api, /allowSharedAuthFallback:\s*choiceSource === ["']server["']/);
  assert.match(api, /errorCode|job\.code|code:\s*job/);
});

await check("ai-jobs public payload includes code on error", async () => {
  const { startAiJob, waitAiJobDone } = await loadFresh("../src/server/ai-jobs.ts");
  const job = startAiJob({
    kind: "unit-error",
    run: async () => {
      const err = new Error("คีย์เซิร์ฟเวอร์ถูกปฏิเสธ");
      err.code = "AI_SERVER_KEY_INVALID";
      throw err;
    },
  });
  const done = await waitAiJobDone(job.id, 5_000);
  assert.equal(done.status, "error");
  assert.equal(done.code, "AI_SERVER_KEY_INVALID");
  assert.match(done.error || "", /ปฏิเสธ/);
});

await check("docs list status/models field names", async () => {
  const apiDoc = readFileSync(join(root, "docs/API-AI-KEYS-AND-SKIP.md"), "utf8");
  assert.match(apiDoc, /\/api\/ai\/keys\/status/);
  assert.match(apiDoc, /\/api\/ai\/keys\/models/);
  assert.match(apiDoc, /serverKeyAvailable/);
  assert.match(apiDoc, /userKeySet/);
  assert.match(apiDoc, /userKeyHint/);
  assert.match(apiDoc, /"source":\s*"server"/);
  assert.match(apiDoc, /source.*byok|byok.*source/i);
});

if (failed) {
  console.error(`ai-key-choice-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-key-choice-unit-test: ok");
