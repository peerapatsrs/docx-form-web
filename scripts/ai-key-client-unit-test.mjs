#!/usr/bin/env node
/**
 * Unit tests for public/ai-key-client.js helpers.
 */
import assert from "node:assert/strict";
import {
  AI_KEY_TEST_ENABLED,
  aiKeyAuthHeaders,
  mapAiKeyError,
  maskAiKeyLocal,
  normalizeMaskedEntry,
} from "../public/ai-key-client.js";

console.log("ai-key-client-unit-test");

assert.equal(AI_KEY_TEST_ENABLED, true);
assert.ok(mapAiKeyError({ code: "AI_PROVIDER_QUOTA" }).includes("เครดิต") || mapAiKeyError({ code: "AI_PROVIDER_QUOTA" }).includes("โควต้า"));
assert.ok(mapAiKeyError({ code: "AI_PROVIDER_TIMEOUT" }).includes("หมดเวลา"));
assert.equal(maskAiKeyLocal("abcdefghij"), "sk-…ghij");
assert.equal(maskAiKeyLocal(""), "••••");

assert.equal(
  mapAiKeyError({ code: "AI_KEY_INVALID" }),
  "คีย์นี้ใช้ไม่ได้ — ตรวจว่าคัดลอกครบ และเป็นคีย์ของผู้ให้บริการที่เลือก จากนั้นลองอีกครั้ง",
);
assert.equal(mapAiKeyError({ error: "ข้อความไทยจากเซิร์ฟเวอร์" }), "ข้อความไทยจากเซิร์ฟเวอร์");
assert.equal(mapAiKeyError({}, 401).includes("เข้าสู่ระบบ"), true);
assert.ok(
  mapAiKeyError({
    error: "API key not valid. Please pass a valid API key.",
  }).includes("คีย์นี้ใช้ไม่ได้"),
);

const entry = normalizeMaskedEntry({
  id: "k-1",
  provider: "google",
  label: "Gemini",
  model: "gemini-3.8-flash",
  maskedKey: "••••…abcd",
  hasKey: true,
  storeOnServer: true,
});
assert.equal(entry?.id, "k-1");
assert.equal(entry?.maskedKey, "••••…abcd");
assert.equal("apiKey" in (entry || {}), false);

const vaultHeaders = aiKeyAuthHeaders(
  { id: "k-1", provider: "google", model: "m", storeOnServer: true },
  { loggedIn: true },
);
assert.equal(vaultHeaders["X-Ai-Key-Id"], "k-1");
assert.equal(vaultHeaders["X-Ai-Api-Key"], undefined);

const localHeaders = aiKeyAuthHeaders(
  { id: "k-2", provider: "google", apiKey: "secret-key-value", storeOnServer: false },
  { loggedIn: false },
);
assert.equal(localHeaders["X-Ai-Api-Key"], "secret-key-value");
assert.equal(localHeaders["X-Ai-Key-Id"], undefined);

console.log("\nAll ai-key-client unit tests passed");
