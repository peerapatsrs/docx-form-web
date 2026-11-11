#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  appendAiKeyRequestFields,
  buildAiModelPickerGroupsFromModels,
  normalizeAiKeyModelsResponse,
  normalizeAiKeySettingsState,
} from "../src/lib/ai-key-settings-adapter.ts";
import {
  buildAiModelGroups,
  formatModelSourceBadge,
  renderAiModelPickerHtml,
  resolveModelSource,
} from "../public/ai-model-picker.js";
import { mapAiKeyError, appendAiKeyRequestFields as appendPublic } from "../public/ai-key-client.js";

console.log("ai-key-settings-adapter-unit-test");

const a = normalizeAiKeySettingsState({
  mode: "server",
  serverKeyAvailable: true,
  userKeySet: false,
});
assert.equal(a.mode, "server");
assert.equal(a.serverKeyAvailable, true);
assert.equal(a.userKeySet, false);
assert.equal(a.userKeyHint, undefined);

const b = normalizeAiKeySettingsState({
  mode: "byok",
  serverKeyAvailable: true,
  userKeySet: true,
  userKeyHint: "••••9abc",
});
assert.equal(b.mode, "byok");
assert.equal(b.userKeySet, true);
assert.equal(b.userKeyHint, "••••9abc");

const legacy = normalizeAiKeySettingsState({ mode: "own", userKeySet: false });
assert.equal(legacy.mode, "byok");

const modelsRes = normalizeAiKeyModelsResponse({
  mode: "server",
  serverKeyAvailable: true,
  userKeySet: true,
  userKeyHint: "••••1234",
  models: [
    { id: "gemini-3.8-flash", label: "Gemini Flash", provider: "google", source: "server" },
    { id: "gpt-4.1", label: "GPT-4.1", provider: "openai", source: "byok" },
  ],
});
assert.equal(modelsRes.models.length, 2);
assert.equal(modelsRes.models[0].source, "server");
assert.equal(modelsRes.models[1].source, "byok");

const groups = buildAiModelPickerGroupsFromModels(modelsRes);
assert.equal(groups.groups[0].id, "server");
assert.equal(groups.groups[0].label, "คีย์กลางของระบบ");
assert.equal(groups.groups[0].disabled, false);
assert.equal(groups.groups[1].id, "byok");
assert.equal(groups.groups[1].label, "คีย์ของฉัน");
assert.equal(groups.groups[1].disabled, false);

const emptyByok = buildAiModelPickerGroupsFromModels({
  mode: "server",
  serverKeyAvailable: true,
  userKeySet: false,
  models: [{ id: "g1", label: "G", provider: "google", source: "server" }],
});
assert.equal(emptyByok.groups[1].disabled, true);
assert.ok(String(emptyByok.groups[1].reason || "").includes("ยังไม่ได้"));

const pickerGroups = buildAiModelGroups({
  serverKeyAvailable: true,
  userKeySet: true,
  models: [
    { id: "gemini-3.8-flash", label: "Gemini Flash", source: "server" },
    { id: "gpt-4.1", label: "GPT-4.1", source: "byok" },
  ],
});
assert.equal(resolveModelSource(pickerGroups, "gpt-4.1"), "byok");
assert.equal(resolveModelSource(pickerGroups, "gemini-3.8-flash"), "server");

const html = renderAiModelPickerHtml({
  groups: pickerGroups,
  selectedId: "gemini-3.8-flash",
  label: "โมเดล",
});
assert.ok(html.includes("คีย์กลางของระบบ"));
assert.ok(html.includes("คีย์ของฉัน"));
assert.ok(html.includes("optgroup"));
assert.ok(html.includes('data-source="server"'));
assert.ok(html.includes("ใช้คีย์กลางของระบบ · Gemini Flash"));
assert.equal(html.includes("AIza"), false);
assert.equal(html.includes("sk-"), false);

const badge = formatModelSourceBadge(pickerGroups, "gpt-4.1");
assert.ok(badge.includes("คีย์ของฉัน"));

const fd = new FormData();
const wired = appendAiKeyRequestFields(fd, {
  source: "server",
  aiModel: "gemini-3.8-flash",
  aiProvider: "google",
});
assert.equal(wired.source, "server");
assert.equal(fd.get("source"), "server");
assert.equal(fd.get("aiModel"), "gemini-3.8-flash");
assert.equal(fd.get("geminiModel"), "gemini-3.8-flash");
assert.equal(fd.get("aiProvider"), "google");

const fd2 = new FormData();
appendPublic(fd2, { source: "byok", aiModel: "gpt-4.1", aiProvider: "openai" });
assert.equal(fd2.get("source"), "byok");
assert.equal(fd2.get("aiModel"), "gpt-4.1");

assert.equal(
  mapAiKeyError({ code: "AI_MODEL_SOURCE_MISMATCH" }),
  "โมเดลนี้ไม่ตรงกับคีย์ที่เลือก กรุณาเลือกใหม่",
);
assert.equal(
  mapAiKeyError({ code: "AI_KEY_REQUIRED" }),
  "ต้องตั้งค่าคีย์ AI ก่อน",
);
assert.equal(
  mapAiKeyError({ code: "AI_SERVER_KEY_INVALID" }),
  "คีย์กลางของระบบใช้ไม่ได้ชั่วคราว กรุณาแจ้งผู้ดูแลระบบ",
);
assert.ok(!mapAiKeyError({ code: "AI_SERVER_KEY_INVALID" }).includes("คีย์ของฉัน"));
assert.ok(
  mapAiKeyError({ code: "AI_SERVER_KEY_UNAVAILABLE" }, 400, "th").length > 3,
);
assert.ok(mapAiKeyError({ code: "AI_KEY_INVALID_MODE" }, 400, "en").length > 3);
assert.ok(mapAiKeyError({ code: "AI_KEY_UNAUTHORIZED" }, 401).includes("เซสชัน"));

console.log("ok: adapter + error codes + picker grouping + multipart source");
