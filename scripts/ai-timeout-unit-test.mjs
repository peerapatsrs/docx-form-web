#!/usr/bin/env node
/**
 * Unit tests: AI timeout layer, cross-family Cursor model remap,
 * and DOCX_FORM_CURSOR_AGENT_MOCK modes (ok / hang / 401).
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
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

async function withEnv(envPatch, fn) {
  const keys = Object.keys(envPatch);
  /** @type {Record<string, string|undefined>} */
  const prev = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    const v = envPatch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
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

async function loadFresh(rel) {
  const url = pathToFileURL(join(root, rel)).href + `?t=${Date.now()}-${Math.random()}`;
  return import(url);
}

console.log("ai-timeout-unit-test");

await check("getAiTimeoutMs reads DOCX_FORM_AI_TIMEOUT_MS", async () => {
  await withEnv({ DOCX_FORM_AI_TIMEOUT_MS: "12000" }, async () => {
    const { getAiTimeoutMs } = await loadFresh("src/server/ai-request.ts");
    assert.equal(getAiTimeoutMs(), 12_000);
  });
  await withEnv({ DOCX_FORM_AI_TIMEOUT_MS: undefined }, async () => {
    const { getAiTimeoutMs, DEFAULT_AI_TIMEOUT_MS } = await loadFresh(
      "src/server/ai-request.ts",
    );
    assert.equal(getAiTimeoutMs(), DEFAULT_AI_TIMEOUT_MS);
  });
});

await check("withAiTimeout aborts never-resolving work with AI_TIMEOUT", async () => {
  const { withAiTimeout, isAiTimeoutError, AiTimeoutError } = await loadFresh(
    "src/server/ai-request.ts",
  );
  const t0 = Date.now();
  let threw = null;
  try {
    await withAiTimeout(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason || new Error("aborted")),
            { once: true },
          );
        }),
      {
        route: "test.hang",
        provider: "cursor",
        model: "composer-2.5",
        timeoutMs: 80,
      },
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AiTimeoutError);
  assert.equal(threw.code, "AI_TIMEOUT");
  assert.ok(isAiTimeoutError(threw));
  assert.ok(Date.now() - t0 < 3_000, "timeout should fire quickly");
});

await check("resolveCursorModelId remaps gemini without live catalog", async () => {
  const { resolveCursorModelId, resolveEffectiveModelForProvider } = await loadFresh(
    "src/server/ai-providers.ts",
  );
  assert.equal(resolveCursorModelId("gemini-3.8-flash", null), "composer-2.5");
  assert.equal(
    resolveEffectiveModelForProvider("cursor", "gemini-3.8-flash"),
    "composer-2.5",
  );
});

await check("resolveCursorModelForCall remaps cross-family before Agent", async () => {
  const { resolveCursorModelForCall, isCrossFamilyCursorModelId } = await loadFresh(
    "src/server/ai-cursor-agent.ts",
  );
  assert.equal(isCrossFamilyCursorModelId("gemini-3.8-flash"), true);
  const model = await resolveCursorModelForCall(
    "crsr_fake_key_for_unit_test_only",
    "gemini-3.8-flash",
  );
  assert.equal(model, "composer-2.5");
});

await check("mock ok returns draft JSON", async () => {
  await withEnv(
    {
      DOCX_FORM_CURSOR_AGENT_MOCK: "ok",
      DOCX_FORM_AI_TIMEOUT_MS: "5000",
    },
    async () => {
      const { callCursorAgentJson } = await loadFresh(
        "src/server/ai-cursor-agent.ts",
      );
      const parsed = await callCursorAgentJson("return json", {
        apiKey: "crsr_mock_ok_key_abcdefgh",
        model: "composer-2.5",
        route: "mock.ok",
      });
      assert.ok(parsed);
      assert.equal(parsed.mock, true);
      assert.ok(Array.isArray(parsed.suggestions));
      assert.ok(parsed.suggestions.length >= 1);
    },
  );
});

await check("mock hang times out with AI_TIMEOUT", async () => {
  await withEnv(
    {
      DOCX_FORM_CURSOR_AGENT_MOCK: "hang",
    },
    async () => {
      const { callCursorAgentJson } = await loadFresh(
        "src/server/ai-cursor-agent.ts",
      );
      const { isAiTimeoutError } = await loadFresh("src/server/ai-request.ts");
      let threw = null;
      const t0 = Date.now();
      try {
        await callCursorAgentJson("hang please", {
          apiKey: "crsr_mock_hang_key_abcdefgh",
          model: "composer-2.5",
          route: "mock.hang",
          timeoutMs: 120,
        });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw, "expected timeout error");
      assert.ok(isAiTimeoutError(threw), String(threw));
      assert.match(String(threw.message), /AI_TIMEOUT/);
      assert.ok(Date.now() - t0 < 3_000);
    },
  );
});

await check("mock 401 returns clear auth error", async () => {
  await withEnv(
    {
      DOCX_FORM_CURSOR_AGENT_MOCK: "401",
      DOCX_FORM_AI_TIMEOUT_MS: "5000",
    },
    async () => {
      const { callCursorAgentJson } = await loadFresh(
        "src/server/ai-cursor-agent.ts",
      );
      let threw = null;
      try {
        await callCursorAgentJson("auth fail", {
          apiKey: "crsr_mock_401_key_abcdefgh",
          model: "composer-2.5",
          route: "mock.401",
        });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw instanceof Error);
      assert.match(threw.message, /API key ไม่ถูกต้อง|หมดอายุ/);
    },
  );
});

await check("geminiStatus exposes aiTimeoutMs + effective cursor model", async () => {
  await withEnv(
    {
      DOCX_FORM_BYOK_ONLY: "0",
      DOCX_FORM_CURSOR_API_KEY: "crsr_shared_server_key_abcdefgh",
      DOCX_FORM_AI_TIMEOUT_MS: "45000",
    },
    async () => {
      const { geminiStatus } = await loadFresh("src/server/ai-config.ts");
      const status = geminiStatus({
        requestProvider: "google",
        requestModel: "gemini-3.8-flash",
        adminDefaultModel: "gemini-3.8-flash",
        adminDefaultProvider: "google",
      });
      assert.equal(status.effectiveProvider, "cursor");
      assert.equal(status.model, "composer-2.5");
      assert.equal(status.aiTimeoutMs, 45_000);
      const pill = `พร้อมใช้ · ${status.effectiveProviderLabel} · ${status.model}`;
      assert.equal(pill, "พร้อมใช้ · Cursor · composer-2.5");
      console.log(`  pill text: ${pill}`);
    },
  );
});

await check("client coerce remaps gemini under cursor (app.js source)", async () => {
  const app = readFileSync(join(root, "public/app.js"), "utf8");
  // FE tip uses coerceClientAiModel (may not ship isCrossFamilyCursorModelId).
  assert.match(app, /function coerceClientAiModel/);
  assert.match(app, /coerceClientAiModel\(/);
});

if (failed) {
  console.error(`ai-timeout-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-timeout-unit-test: ok");
