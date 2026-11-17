#!/usr/bin/env node
/**
 * Unit tests: static table-cell {{tags}} → inputs (never raw text) + field seeding fallback.
 */
import assert from "node:assert/strict";
import {
  collectSelfTagsFromLayout,
  collectSelfTagsFromText,
  fieldTableLocation,
  isStackableStaticTable,
  mergeMissingTextFields,
  renderCellTemplateHtml,
  tokenizeTemplate,
} from "../public/doc-table-fields.js";

console.log("doc-table-fields-unit-test");

const tags = collectSelfTagsFromText("ชื่อ {{ชื่อผู้ติดต่อ}} / {{เบอร์โทร}}");
assert.deepEqual(tags, ["ชื่อผู้ติดต่อ", "เบอร์โทร"]);

const tokens = tokenizeTemplate("{{อีเมล}}");
assert.equal(tokens.length, 1);
assert.equal(tokens[0].type, "self");
assert.equal(tokens[0].name, "อีเมล");

const layout = [
  {
    type: "table",
    staticRows: [
      [{ text: "ชื่อ" }, { text: "{{ชื่อผู้ติดต่อ}}" }],
      [{ text: "โทรศัพท์" }, { text: "{{เบอร์โทร}}" }],
      [{ text: "อีเมล" }, { text: "{{อีเมล}}" }],
      [{ text: "หมายเหตุ" }, { text: "{{หมายเหตุ}}" }],
    ],
  },
];
const fromLayout = collectSelfTagsFromLayout(layout);
assert.deepEqual(fromLayout.sort(), ["ชื่อผู้ติดต่อ", "เบอร์โทร", "อีเมล", "หมายเหตุ"].sort());

assert.equal(isStackableStaticTable(layout[0]), true);
assert.equal(
  isStackableStaticTable({ type: "table", listName: "items", staticRows: [[{ text: "a" }]] }),
  false,
);

const merged = mergeMissingTextFields(
  [{ name: "ชื่อผู้กู้", type: "text" }],
  fromLayout,
);
assert.equal(merged.added.length, 4);
assert.ok(merged.fields.some((f) => f.name === "อีเมล" && f.type === "text"));
const noop = mergeMissingTextFields(
  [
    { name: "ชื่อผู้ติดต่อ", type: "text" },
    { name: "เบอร์โทร", type: "text" },
    { name: "อีเมล", type: "text" },
    { name: "หมายเหตุ", type: "text" },
  ],
  fromLayout,
);
assert.deepEqual(noop.added, []);

const html = renderCellTemplateHtml(
  "{{ชื่อผู้ติดต่อ}}",
  (name) =>
    `<span class="doc-blank-wrap"><input class="doc-blank" data-doc-field="${name}" /><label class="doc-skip"><input type="checkbox" data-skip-field="${name}" />ข้าม</label></span>`,
  (t) => t.replace(/</g, "&lt;"),
);
assert.ok(html.includes('data-doc-field="ชื่อผู้ติดต่อ"'));
assert.ok(html.includes("ข้าม"));
assert.ok(html.includes('data-skip-field="ชื่อผู้ติดต่อ"'));
assert.equal(html.includes("{{"), false);

const mixed = renderCellTemplateHtml(
  "ติดต่อ {{ชื่อผู้ติดต่อ}}",
  (name) => `<input data-doc-field="${name}" />`,
  (t) => t,
);
assert.ok(mixed.startsWith("ติดต่อ "));
assert.ok(mixed.includes('data-doc-field="ชื่อผู้ติดต่อ"'));
assert.equal(mixed.includes("{{ชื่อผู้ติดต่อ}}"), false);

assert.deepEqual(
  fieldTableLocation({
    name: "อีเมล",
    type: "text",
    location: { tableIndex: 0, rowIndexInTable: 2, cellIndex: 1 },
  }),
  { tableIndex: 0, rowIndexInTable: 2, cellIndex: 1 },
);
assert.equal(fieldTableLocation({ name: "อีเมล", type: "text" }), null);
assert.deepEqual(
  fieldTableLocation({ name: "x", type: "text", tableIndex: 1, cellIndex: 0 }),
  { tableIndex: 1, cellIndex: 0 },
);

console.log("ok: doc-table-fields unit tests passed");
