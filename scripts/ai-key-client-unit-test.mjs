#!/usr/bin/env node
/**
 * Unit tests for public/ai-key-client.js helpers.
 */
import assert from "node:assert/strict";
import {
  AI_KEY_TEST_ENABLED,
  aiKeyAuthHeaders,
  mapAiKeyError,
  mapAiKeySuccess,
  mapFillError,
  maskAiKeyLocal,
  normalizeMaskedEntry,
} from "../public/ai-key-client.js";

console.log("ai-key-client-unit-test");

assert.equal(AI_KEY_TEST_ENABLED, true);
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

const codes = [
  "AI_KEY_UNAUTHORIZED",
  "AI_KEY_NOT_FOUND",
  "AI_KEY_INVALID_ID",
  "AI_KEY_INVALID_PROVIDER",
  "AI_KEY_INVALID_VALUE",
  "AI_KEY_MISSING",
  "AI_KEY_INVALID",
  "AI_KEY_MISSING_FIELDS",
  "AI_KEY_EXISTS",
  "AI_KEY_PROVIDER_AUTH",
  "AI_KEY_PROVIDER_ERROR",
  "AI_KEY_TEST_TIMEOUT",
  "AI_KEY_SERVER_ERROR",
  "AI_PROVIDER_AUTH",
  "AI_PROVIDER_RATE_LIMIT",
  "AI_PROVIDER_QUOTA",
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_PROVIDER_BAD_REQUEST",
  "AI_PROVIDER_ERROR",
];
for (const code of codes) {
  const th = mapAiKeyError({ code }, 400, "th");
  const en = mapAiKeyError({ code }, 400, "en");
  assert.ok(th && th.length > 3, `missing TH for ${code}`);
  assert.ok(en && en.length > 3, `missing EN for ${code}`);
  assert.notEqual(th, code);
  assert.notEqual(en, code);
}
console.log("✓ mapAiKeyError covers AI key + provider codes (TH/EN)");

for (const code of [
  "AI_KEY_CREATED",
  "AI_KEY_REPLACED",
  "AI_KEY_DELETED",
  "AI_KEY_USED",
  "AI_KEY_TEST_OK",
]) {
  assert.ok(mapAiKeySuccess({ code }, "th").length > 2);
  assert.ok(mapAiKeySuccess({ code }, "en").length > 2);
}
assert.equal(mapAiKeySuccess({ code: "AI_KEY_TEST_OK" }, "th"), "คีย์ใช้งานได้");
console.log("✓ mapAiKeySuccess");

for (const code of [
  "FILL_MISSING_FILE",
  "FILL_INVALID_FILE",
  "FILL_MISSING_VALUES",
  "FILL_BAD_JSON",
  "FILL_BAD_SKIP",
  "FILL_BAD_ROW_SKIP",
  "FILL_LIST_NOT_ARRAY",
  "FILL_IMAGE_TOO_LARGE",
  "FILL_IMAGE_INVALID",
]) {
  assert.ok(mapFillError({ code }, 400, "th").length > 3);
  assert.ok(mapFillError({ code }, 400, "en").length > 3);
}
assert.equal(
  mapFillError({ error: "ดิบจากเซิร์ฟเวอร์" }, 400, "th"),
  "ดิบจากเซิร์ฟเวอร์",
);
assert.equal(
  mapFillError({}, 400, "th", "สร้างเอกสารไม่สำเร็จ"),
  "สร้างเอกสารไม่สำเร็จ",
);
console.log("✓ mapFillError");

const entry = normalizeMaskedEntry({
  id: "k-1",
  provider: "google",
  label: "Gemini",
  model: "gemini-3.8-flash",
  maskedKey: "••••…abcd",
  hasKey: true,
  storeOnServer: true,
  lastTestStatus: "ok",
  lastTestOk: true,
  lastTestCode: "AI_KEY_TEST_OK",
});
assert.equal(entry?.id, "k-1");
assert.equal(entry?.maskedKey, "••••…abcd");
assert.equal(entry?.lastTestStatus, "ok");
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
