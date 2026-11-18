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

await check("parseEnvInt: unset/blank uses fallback (retries default 2)", async () => {
  await withEnv({ DOCX_FORM_AI_RETRY_MAX: undefined }, async () => {
    const { getAiRetryMax, parseEnvInt, DEFAULT_AI_RETRY_MAX } = await loadFresh(
      "src/server/ai-request.ts",
    );
    assert.equal(getAiRetryMax(), DEFAULT_AI_RETRY_MAX);
    assert.equal(DEFAULT_AI_RETRY_MAX, 2);
    assert.equal(parseEnvInt("DOCX_FORM_AI_RETRY_MAX", 2, 0, 4), 2);
  });
  await withEnv({ DOCX_FORM_AI_RETRY_MAX: "" }, async () => {
    const { getAiRetryMax, DEFAULT_AI_RETRY_MAX } = await loadFresh(
      "src/server/ai-request.ts",
    );
    assert.equal(getAiRetryMax(), DEFAULT_AI_RETRY_MAX);
  });
  await withEnv({ DOCX_FORM_AI_RETRY_MAX: "   " }, async () => {
    const { getAiRetryMax, DEFAULT_AI_RETRY_MAX } = await loadFresh(
      "src/server/ai-request.ts",
    );
    assert.equal(getAiRetryMax(), DEFAULT_AI_RETRY_MAX);
  });
  await withEnv({ DOCX_FORM_AI_RETRY_MAX: "0" }, async () => {
    const { getAiRetryMax } = await loadFresh("src/server/ai-request.ts");
    assert.equal(getAiRetryMax(), 0, "explicit 0 still allowed");
  });
  await withEnv({ DOCX_FORM_AI_RETRY_MAX: "3" }, async () => {
    const { getAiRetryMax } = await loadFresh("src/server/ai-request.ts");
    assert.equal(getAiRetryMax(), 3);
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

await check("withAiTimeout hard-races even when provider ignores abort", async () => {
  const { withAiTimeout, isAiTimeoutError, AiTimeoutError } = await loadFresh(
    "src/server/ai-request.ts",
  );
  const t0 = Date.now();
  let threw = null;
  try {
    await withAiTimeout(
      // Provider ignores AbortSignal entirely (Cursor SDK hang case).
      () => new Promise(() => {}),
      {
        route: "test.hang.ignore-abort",
        provider: "cursor",
        model: "composer-2.5",
        timeoutMs: 80,
      },
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof AiTimeoutError);
  assert.ok(isAiTimeoutError(threw));
  assert.ok(Date.now() - t0 < 3_000, "hard race must settle without abort listener");
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

await check("event loop stays responsive after withAiTimeout abandons a spinner", async () => {
  const { withAiTimeout, isAiTimeoutError } = await loadFresh(
    "src/server/ai-request.ts",
  );
  // Simulate SDK gotoReady: ignore AbortSignal and spin the CPU in a tight loop
  // scheduled on the microtask/macrotask queue via setImmediate chunks so the
  // timeout timer can still fire — then verify the loop is aborted and the
  // event loop responds within a few dozen ms.
  let spinning = true;
  const spinner = () => {
    if (!spinning) return;
    const end = Date.now() + 5;
    while (Date.now() < end) {
      /* burn */
    }
    if (spinning) setImmediate(spinner);
  };
  setImmediate(spinner);
  let threw = null;
  try {
    await withAiTimeout(
      (signal) =>
        new Promise((_, reject) => {
          // Provider ignores abort for the work itself (SDK hang) — only the
          // race deadline settles the promise. Mirror Cursor: detach on abort.
          signal.addEventListener(
            "abort",
            () => {
              spinning = false;
              reject(signal.reason || new Error("aborted"));
            },
            { once: true },
          );
        }),
      { route: "test.spin", provider: "cursor", timeoutMs: 80 },
    );
  } catch (err) {
    threw = err;
  }
  spinning = false;
  assert.ok(isAiTimeoutError(threw), String(threw));
  const t0 = Date.now();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    Date.now() - t0 < 200,
    `event loop blocked after timeout (${Date.now() - t0}ms)`,
  );
});

await check("Cursor hang mock: child SIGKILL keeps parent event loop responsive", async () => {
  await withEnv(
    {
      DOCX_FORM_CURSOR_AGENT_MOCK: "hang",
      DOCX_FORM_AI_TIMEOUT_MS: "200",
      DOCX_FORM_CURSOR_AGENT_INPROCESS: undefined,
    },
    async () => {
      const { callCursorAgentJson } = await loadFresh(
        "src/server/ai-cursor-agent.ts",
      );
      const { isAiTimeoutError } = await loadFresh("src/server/ai-request.ts");
      let threw = null;
      const tCall = Date.now();
      try {
        await callCursorAgentJson("hang in killable child", {
          apiKey: "crsr_mock_hang_key_abcdefgh",
          model: "composer-2.5",
          route: "mock.hang.child",
          timeoutMs: 200,
        });
      } catch (err) {
        threw = err;
      }
      assert.ok(isAiTimeoutError(threw), String(threw));
      assert.ok(
        Date.now() - tCall < 3_000,
        `hang mock took too long (${Date.now() - tCall}ms)`,
      );
      const t0 = Date.now();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(
        Date.now() - t0 < 250,
        `event loop blocked after child SIGKILL (${Date.now() - t0}ms)`,
      );
    },
  );
});

await check("suggest call timeout helper hard-caps at 120s", async () => {
  const {
    getAiSuggestCallTimeoutMs,
    getAiSuggestOverallBudgetMs,
    DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS,
    DEFAULT_AI_SUGGEST_OVERALL_MS,
  } = await loadFresh("src/server/ai-tag-draft.ts");
  assert.equal(DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS, 120_000);
  assert.equal(DEFAULT_AI_SUGGEST_OVERALL_MS, 300_000);
  assert.equal(getAiSuggestCallTimeoutMs(500_000), 120_000);
  assert.equal(getAiSuggestCallTimeoutMs(30_000), 30_000);
  assert.equal(getAiSuggestOverallBudgetMs(999_999), 300_000);
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

await check("getAiTimeoutMsForPayload scales with document size", async () => {
  await withEnv(
    {
      DOCX_FORM_AI_TIMEOUT_MS: "90000",
      DOCX_FORM_AI_TIMEOUT_EXTRA_MS_PER_MIB: "8000",
    },
    async () => {
      const {
        getAiTimeoutMsForPayload,
        getAiTimeoutMs,
        AI_TIMEOUT_SCALE_SOFT_BYTES,
      } = await loadFresh("src/server/ai-request.ts");
      assert.equal(getAiTimeoutMsForPayload(0), getAiTimeoutMs());
      assert.equal(
        getAiTimeoutMsForPayload(AI_TIMEOUT_SCALE_SOFT_BYTES),
        getAiTimeoutMs(),
      );
      const twoMiBOver = AI_TIMEOUT_SCALE_SOFT_BYTES + 2 * 1024 * 1024;
      const scaled = getAiTimeoutMsForPayload(twoMiBOver);
      assert.equal(scaled, 90_000 + 16_000);
    },
  );
  await withEnv(
    {
      DOCX_FORM_AI_TIMEOUT_MS: "90000",
      DOCX_FORM_AI_TIMEOUT_EXTRA_MS_PER_MIB: "0",
    },
    async () => {
      const { getAiTimeoutMsForPayload } = await loadFresh(
        "src/server/ai-request.ts",
      );
      assert.equal(
        getAiTimeoutMsForPayload(5 * 1024 * 1024),
        90_000,
        "extra=0 disables scaling",
      );
    },
  );
});

await check("isRetryableAiError: timeout/transient yes, 401/4xx no", async () => {
  const {
    isRetryableAiError,
    AiTimeoutError,
  } = await loadFresh("src/server/ai-request.ts");
  assert.equal(isRetryableAiError(new AiTimeoutError()), true);
  assert.equal(
    isRetryableAiError(Object.assign(new Error("rate"), { status: 429 })),
    true,
  );
  assert.equal(
    isRetryableAiError(Object.assign(new Error("busy"), { status: 503 })),
    true,
  );
  assert.equal(
    isRetryableAiError(new Error("Google AI: เรียกถี่เกินไป — wait")),
    true,
  );
  assert.equal(
    isRetryableAiError(Object.assign(new Error("nope"), { status: 401 })),
    false,
  );
  assert.equal(
    isRetryableAiError(Object.assign(new Error("bad"), { status: 400 })),
    false,
  );
  assert.equal(
    isRetryableAiError(
      Object.assign(new Error("auth"), { code: "AI_KEY_INVALID" }),
    ),
    false,
  );
  assert.equal(
    isRetryableAiError(new Error("OpenAI: API key หรือสิทธิ์ไม่ถูกต้อง")),
    false,
  );
});

await check("withAiRetry succeeds after mocked timeout then ok", async () => {
  const { withAiRetry, AiTimeoutError, isAiTimeoutError } = await loadFresh(
    "src/server/ai-request.ts",
  );
  let calls = 0;
  const t0 = Date.now();
  const result = await withAiRetry(
    async (_signal, attempt, timeoutMs) => {
      calls += 1;
      assert.ok(timeoutMs > 0);
      if (attempt < 3) {
        throw new AiTimeoutError(
          `AI_TIMEOUT: mock hang attempt ${attempt}`,
        );
      }
      return { ok: true, attempt };
    },
    {
      route: "test.retry.timeout",
      retryMax: 2,
      backoffMs: 20,
      timeoutMs: 200,
      overallTimeoutMs: 5_000,
    },
  );
  assert.deepEqual(result, { ok: true, attempt: 3 });
  assert.equal(calls, 3);
  assert.ok(Date.now() - t0 < 4_000);
  assert.equal(isAiTimeoutError(new AiTimeoutError()), true);
});

await check("withAiRetry does not retry 401 / AI_AUTH", async () => {
  const { withAiRetry } = await loadFresh("src/server/ai-request.ts");
  let calls = 0;
  let threw = null;
  try {
    await withAiRetry(
      async () => {
        calls += 1;
        const err = new Error("API key หรือสิทธิ์ไม่ถูกต้อง");
        err.code = "AI_AUTH";
        err.status = 401;
        throw err;
      },
      {
        route: "test.retry.401",
        retryMax: 3,
        backoffMs: 10,
        timeoutMs: 500,
        overallTimeoutMs: 3_000,
      },
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  assert.equal(calls, 1, "must not retry auth failures");
  assert.match(String(threw.message), /API key/);
});

await check("withAiRetry retries transient 503 then preserves final timeout code", async () => {
  const { withAiRetry, AiTimeoutError, isAiTimeoutError } = await loadFresh(
    "src/server/ai-request.ts",
  );
  let calls = 0;
  let threw = null;
  try {
    await withAiRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("เซิร์ฟเวอร์โหลดสูงชั่วคราว");
          err.status = 503;
          throw err;
        }
        throw new AiTimeoutError("AI_TIMEOUT: still hanging");
      },
      {
        route: "test.retry.503.then.timeout",
        retryMax: 1,
        backoffMs: 15,
        timeoutMs: 200,
        overallTimeoutMs: 3_000,
      },
    );
  } catch (err) {
    threw = err;
  }
  assert.equal(calls, 2);
  assert.ok(isAiTimeoutError(threw));
  assert.equal(threw.code, "AI_TIMEOUT");
});

if (failed) {
  console.error(`ai-timeout-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-timeout-unit-test: ok");
