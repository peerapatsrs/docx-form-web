#!/usr/bin/env node
/**
 * Fixture / e2e-ish coverage for table-cell {{vars}} in fill preview.
 * Uses fixtures/fill-form/docx-form-test-tagged.docx (owner DEV bug repro).
 *
 * Relies on Backend FormField shape:
 *   { name: string, type: "text"|"image"|"list"|"bool"|"auto", aliases?: string[],
 *     location?: { tableIndex?, rowIndexInTable?, cellIndex? } }  // optional
 * Layout staticRows cells: { text: string, fieldName?: string, tags?: string[] }
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSelfTagsFromLayout,
  isStackableStaticTable,
  mergeMissingTextFields,
  renderCellTemplateHtml,
} from "../public/doc-table-fields.js";
import { extractDocumentLayout, parseTemplate } from "../src/server/docx-engine.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(
  __dirname,
  "..",
  "fixtures",
  "fill-form",
  "docx-form-test-tagged.docx",
);

console.log("doc-table-fields-fixture-test");
assert.ok(fs.existsSync(fixture), `missing fixture: ${fixture}`);

const buf = fs.readFileSync(fixture);
const parsed = await parseTemplate(buf);
const layout = await extractDocumentLayout(buf);

const expectedCellFields = ["ชื่อผู้ติดต่อ", "เบอร์โทร", "อีเมล", "หมายเหตุ"];
const fieldNames = parsed.fields.map((f) => f.name);
for (const name of expectedCellFields) {
  assert.ok(
    fieldNames.includes(name),
    `Backend fields should include cell tag ${name} (got: ${fieldNames.join(", ")})`,
  );
  const f = parsed.fields.find((x) => x.name === name);
  assert.equal(f.type, "text");
}

const staticTables = layout.blocks.filter(
  (b) => b.type === "table" && Array.isArray(b.staticRows) && b.staticRows.length,
);
assert.ok(staticTables.length >= 1, "fixture should have a static (non-loop) table");
const table = staticTables[0];
assert.equal(isStackableStaticTable(table), true);

const cellTexts = [];
for (const row of table.staticRows) {
  for (const c of row) cellTexts.push(typeof c === "string" ? c : c?.text || "");
}
for (const name of expectedCellFields) {
  assert.ok(
    cellTexts.some((t) => t.includes(`{{${name}}}`)),
    `staticRows should contain {{${name}}}`,
  );
}

const layoutTags = collectSelfTagsFromLayout(layout.blocks);
for (const name of expectedCellFields) {
  assert.ok(layoutTags.includes(name), `layout scan missed ${name}`);
}

/** Simulate FE render: every tag cell becomes an input + ข้าม, never raw {{}}. */
function fakeRenderSelf(name) {
  return `<span class="doc-blank-wrap"><input class="doc-blank" data-doc-field="${name}" style="min-height:44px" /><label class="doc-skip" style="min-height:44px"><input type="checkbox" data-skip-field="${name}" />ข้าม</label></span>`;
}
for (const text of cellTexts) {
  if (!/\{\{/.test(text)) continue;
  const html = renderCellTemplateHtml(text, fakeRenderSelf, (t) => t);
  assert.equal(html.includes("{{"), false, `raw tag leaked for cell: ${text}`);
  assert.ok(html.includes("data-doc-field="), `no input for cell: ${text}`);
  assert.ok(html.includes("data-skip-field="), `no skip for cell: ${text}`);
  assert.ok(html.includes("ข้าม"), `no ข้าม label for cell: ${text}`);
}

/** Client fallback: if Backend omitted cell fields, seed from layout tags. */
const stripped = parsed.fields.filter((f) => !expectedCellFields.includes(f.name));
const { fields: seeded, added } = mergeMissingTextFields(stripped, layoutTags);
assert.deepEqual(added.sort(), expectedCellFields.slice().sort());
for (const name of expectedCellFields) {
  assert.ok(seeded.some((f) => f.name === name && f.type === "text"));
}

/** CSS contract: mobile tap targets ≥ 44px for table-cell blanks + skip. */
const css = fs.readFileSync(
  path.join(__dirname, "..", "public", "style.css"),
  "utf8",
);
assert.ok(
  /\/\* —— Static table-cell fields/.test(css) ||
    /\.doc-table td \.doc-blank[\s\S]*min-height:\s*44px/.test(css),
  "style.css should set min-height:44px on table-cell inputs",
);
assert.ok(
  /\.doc-table td \.doc-skip[\s\S]*min-height:\s*44px/.test(css),
  "style.css should set min-height:44px on table-cell ข้าม",
);
assert.ok(
  /\.doc-table-stackable/.test(css) && /max-width:\s*430px/.test(css),
  "style.css should stack simple static tables around 390px",
);
assert.ok(
  /min-width:\s*1280px/.test(css) &&
    /\.doc-table\.doc-table-stackable[\s\S]*display:\s*table/.test(css),
  "style.css should restore table layout at 1280px",
);

console.log("ok: fixture table-cell fields render as inputs + skip; fallback seeds missing fields");
console.log(
  "field shape relied on:",
  JSON.stringify({
    FormField: "{ name, type, aliases?, location?: { tableIndex, rowIndexInTable, cellIndex } }",
    LayoutCell: "{ text, widthDxa?, align?, fieldName?, tags? }",
    staticRows: "LayoutTableBlock.staticRows[][] (non-loop table)",
  }),
);
