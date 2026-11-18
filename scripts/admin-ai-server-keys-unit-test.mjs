#!/usr/bin/env node
/**
 * Admin AI server-key sources — catalog-driven, no Gemini-specific UI rows.
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

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
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

async function loadAiConfig() {
  return import(`../src/server/ai-config.ts?t=${Date.now()}-${Math.random()}`);
}

await check("no configured sources → empty list (BYOK or unset)", async () => {
  process.env.DOCX_FORM_BYOK_ONLY = "1";
  delete process.env.DOCX_FORM_CURSOR_API_KEY;
  delete process.env.DOCX_FORM_GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const { listConfiguredServerKeySources, geminiStatus } = await loadAiConfig();
  assert.deepEqual(listConfiguredServerKeySources(), []);
  const status = geminiStatus({});
  assert.deepEqual(status.serverKeySources, []);
  assert.equal(status.hasClearableServerKey, false);
});

await check("cursor env key surfaces via catalog label (not hardcoded UI)", async () => {
  process.env.DOCX_FORM_BYOK_ONLY = "0";
  process.env.DOCX_FORM_CURSOR_API_KEY = "crsr_unit_test_shared_key_xxxxx";
  delete process.env.DOCX_FORM_GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const { listConfiguredServerKeySources } = await loadAiConfig();
  const rows = listConfiguredServerKeySources();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerId, "cursor");
  assert.match(rows[0].label, /Cursor/i);
  assert.equal(rows[0].sourceLabel, "set via server");
  assert.equal(rows[0].clearable, false);
});

await check("admin page lists serverKeySources generically", async () => {
  const page = readFileSync(join(root, "src/app/admin/ai/page.tsx"), "utf8");
  assert.match(page, /serverKeySources/);
  assert.match(page, /ไม่ได้ตั้งค่าคีย์เซิร์ฟเวอร์/);
  assert.match(page, /คีย์เซิร์ฟเวอร์ · \{src\.label\}/);
  assert.doesNotMatch(page, /คีย์ Gemini ของเซิร์ฟเวอร์/);
  assert.doesNotMatch(page, /คีย์ Cursor ของเซิร์ฟเวอร์/);
  assert.doesNotMatch(page, /Gemini server key/);
});

if (failed > 0) {
  console.error(`\n${failed} admin-ai-server-keys unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll admin-ai-server-keys unit tests passed");
