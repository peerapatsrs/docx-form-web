import assert from "node:assert/strict";
import { TagDisposition, TagPlacement } from "easy-template-x";
import {
  fieldIdentityKey,
  normalizeVarName,
  validateVarName,
} from "../src/server/field-names.ts";
import { tagsToFieldsWithWarnings } from "../src/server/docx-engine.ts";
import { formatTemplateError } from "../src/server/docx-errors.ts";
import { maskGeminiKey } from "../src/server/ai-config.ts";
import {
  countFilledValues,
  isFilledValue,
} from "../src/server/source-map.ts";

console.log("qa-unit-test");

assert.equal(fieldIdentityKey(" Name "), fieldIdentityKey("name"));
assert.equal(normalizeVarName("  a   b  "), "a b");
assert.equal(validateVarName("ok_name"), null);
assert.ok(validateVarName("bad name!"));
console.log("✓ field-names");

const tags = [
  { name: "outer", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
  { name: "a", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "inner", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
  { name: "b", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "inner", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  { name: "outer", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  { name: "Name", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "name", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: " Name ", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
];
const { fields } = tagsToFieldsWithWarnings(/** @type {any} */ (tags));
const outer = fields.find((f) => f.name === "outer");
assert.ok(outer && outer.type === "list");
assert.ok(outer.itemFields.find((f) => f.type === "list" && f.name === "inner"));
const texts = fields.filter((f) => f.type === "text");
assert.equal(texts.length, 1);
assert.ok((texts[0].aliases || []).length >= 1);
console.log("✓ tagsToFields nested+dedupe");

assert.match(formatTemplateError(new Error("Tag {{#items}} is never closed")), /แท็กเปิด/);
assert.match(formatTemplateError(new Error("Can't find end of central directory")), /เสีย|เปิดไม่ได้/);
assert.match(formatTemplateError(new Error("encrypted package https://example.com/docs")), /รหัสผ่าน/);
assert.doesNotMatch(
  formatTemplateError(new Error("see https://github.com/easy-template-x for help")),
  /https?:/,
);
console.log("✓ formatTemplateError");

const masked = maskGeminiKey("ABCDEFGHIJKLMNOPQRSTUV");
assert.ok(masked.startsWith("••••"));
assert.ok(!masked.includes("ABCDEF"));
console.log("✓ maskGeminiKey");

assert.equal(isFilledValue(true), true);
assert.equal(isFilledValue(false), false);
assert.equal(isFilledValue(""), false);
assert.equal(isFilledValue("  "), false);
assert.equal(isFilledValue(null), false);
assert.equal(isFilledValue(undefined), false);
assert.equal(isFilledValue([]), false);
assert.equal(isFilledValue([{}]), false);
assert.equal(isFilledValue([{ a: "" }, { b: false }]), false);
assert.equal(isFilledValue([{ a: "x" }]), true);
assert.equal(isFilledValue({ a: false, b: "" }), false);
assert.equal(isFilledValue({ a: false, b: "ok" }), true);
assert.equal(isFilledValue(0), true);

const emptyFill = countFilledValues({
  format: "docx-form-values",
  version: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  template: "t.docx",
  fields: [
    { name: "flag", type: "bool" },
    { name: "name", type: "text" },
    { name: "rows", type: "list" },
  ],
  values: { flag: false, name: "", rows: [{ item: false }, { item: "" }] },
  skip: {},
  rowSkip: {},
  images: {},
});
assert.equal(emptyFill.filled, 0);
assert.equal(emptyFill.skipped, 3);
assert.equal(emptyFill.total, 3);

const mixedFill = countFilledValues({
  format: "docx-form-values",
  version: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  template: "t.docx",
  fields: [
    { name: "flag", type: "bool" },
    { name: "name", type: "text" },
    { name: "other", type: "text" },
  ],
  values: { flag: true, name: "Ada", other: "" },
  skip: { other: true },
  rowSkip: {},
  images: {},
});
assert.equal(mixedFill.filled, 2);
assert.equal(mixedFill.skipped, 1);
console.log("✓ countFilledValues false/empty");

console.log("\nAll qa unit tests passed");
