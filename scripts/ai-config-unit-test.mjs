import assert from "node:assert/strict";

const ENV = process.env;

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

async function loadAiConfig() {
  const url = new URL("../src/server/ai-config.ts", import.meta.url);
  url.searchParams.set("t", String(Date.now()));
  return import(url.href);
}

console.log("ai-config-unit-test");

const BYOK_USER = "crsr_byok_user_key_12345678";
const SHARED = "crsr_shared_server_key_abcdefgh";

await withEnv(
  {
    DOCX_FORM_BYOK_ONLY: "0",
    DOCX_FORM_CURSOR_API_KEY: SHARED,
  },
  async () => {
    const {
      getCursorApiKey,
      hasServerEnvCursorKey,
      geminiStatus,
      hasRequestAiKey,
      resolveProviderApiKey,
    } = await loadAiConfig();

    assert.equal(getCursorApiKey(BYOK_USER), BYOK_USER);
    assert.equal(getCursorApiKey(undefined), SHARED);
    assert.equal(getCursorApiKey(""), SHARED);
    assert.ok(hasServerEnvCursorKey());
    assert.ok(hasRequestAiKey("cursor", BYOK_USER));
    assert.ok(hasRequestAiKey("cursor", undefined));
    assert.equal(resolveProviderApiKey("cursor", BYOK_USER), BYOK_USER);
    assert.equal(resolveProviderApiKey("cursor", undefined), SHARED);

    const status = geminiStatus({ requestProvider: "cursor" });
    assert.equal(status.hasServerEnvCursorKey, true);
    assert.equal(status.connected, true);
  },
);

await withEnv(
  {
    DOCX_FORM_BYOK_ONLY: "1",
    DOCX_FORM_CURSOR_API_KEY: SHARED,
  },
  async () => {
    const { getCursorApiKey, hasRequestAiKey, geminiStatus } =
      await loadAiConfig();

    assert.equal(getCursorApiKey(undefined), undefined);
    assert.equal(getCursorApiKey(BYOK_USER), BYOK_USER);
    assert.ok(!hasRequestAiKey("cursor", undefined));
    assert.ok(hasRequestAiKey("cursor", BYOK_USER));

    const status = geminiStatus({ requestProvider: "cursor" });
    assert.equal(status.hasServerEnvCursorKey, true);
    assert.equal(status.connected, false);
  },
);

console.log("ai-config-unit-test: ok");
