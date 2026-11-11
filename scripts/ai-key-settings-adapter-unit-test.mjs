#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildAiModelPickerGroups,
  normalizeAiKeySettingsState,
} from "../src/lib/ai-key-settings-adapter.ts";
import {
  buildAiModelGroups,
  formatModelSourceBadge,
  renderAiModelPickerHtml,
} from "../public/ai-model-picker.js";

console.log("ai-key-settings-adapter-unit-test");

const a = normalizeAiKeySettingsState(
  {
    mode: "server",
    serverKeyAvailable: true,
    userKeySet: false,
  },
  { entries: [] },
);
assert.equal(a.mode, "server");
assert.equal(a.serverKeyAvailable, true);
assert.equal(a.serverKeyAvailabilityKnown, true);
assert.equal(a.userKeySet, false);

const b = normalizeAiKeySettingsState(
  { serverAiKeyConfigured: true, keySource: "shared" },
  {
    entries: [{ id: "k1", maskedKey: "••••9abc", hasKey: true }],
  },
  { preferredMode: "byok" },
);
assert.equal(b.mode, "byok");
assert.equal(b.serverKeyAvailable, true);
assert.equal(b.userKeySet, true);
assert.equal(b.userKeyHint, "••••9abc");

const c = normalizeAiKeySettingsState({}, { entries: [] });
assert.equal(c.serverKeyAvailabilityKnown, false);
assert.equal(c.serverKeyAvailable, false);

const legacy = normalizeAiKeySettingsState({ mode: "own" }, { entries: [] });
assert.equal(legacy.mode, "byok");

const groups = buildAiModelPickerGroups({
  state: {
    mode: "server",
    serverKeyAvailable: true,
    serverKeyAvailabilityKnown: true,
    userKeySet: false,
  },
  serverModels: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }],
  byokModels: [{ id: "gpt-4.1", label: "GPT-4.1" }],
});
assert.equal(groups.groups[0].id, "server");
assert.equal(groups.groups[0].disabled, false);
assert.equal(groups.groups[1].disabled, true);
assert.ok(groups.backendFieldNeed.includes("models[].source"));

const pickerGroups = buildAiModelGroups({
  serverKeyAvailable: true,
  userKeySet: true,
  serverModels: [{ id: "gemini-3.8-flash", label: "Gemini Flash" }],
  byokModels: [{ id: "gpt-4.1", label: "GPT-4.1" }],
});
const html = renderAiModelPickerHtml({
  groups: pickerGroups,
  selectedId: "gemini-3.8-flash",
  label: "โมเดล",
});
assert.ok(html.includes("คีย์กลางของระบบ"));
assert.ok(html.includes("คีย์ของฉัน"));
assert.ok(html.includes("optgroup"));
assert.ok(html.includes("ใช้คีย์กลางของระบบ · Gemini Flash"));
assert.equal(html.includes("AIza"), false);
assert.equal(html.includes("sk-"), false);

const badge = formatModelSourceBadge(pickerGroups, "gpt-4.1");
assert.ok(badge.includes("คีย์ของฉัน"));

console.log("ok: ai-key-settings adapter + model picker");
