#!/usr/bin/env node
/**
 * Non-loop table cells with {{tags}} must parse as normal fields with optional
 * location, appear in layout.staticRows with fieldName/tags[], fill into the
 * right cells, and honour skip. Loop tables must keep working.
 *
 * FE tip owns the cell-input UI (public/doc-table-fields.js); this covers Backend.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const FIX = join(root, "fixtures", "tag-parse");
const FIXTURE =
  [
    join(root, "fixtures/fill-form/docx-form-test-tagged.docx"),
    join(root, "fixtures/docx-form-test-tagged.docx"),
  ].find((p) => existsSync(p)) ||
  join(root, "fixtures/fill-form/docx-form-test-tagged.docx");

const { fillTemplate, parseTemplate } = await import("../src/server/docx-engine.ts");
const {
  extractDocumentLayout,
  extractSelfTagsFromCellText,
} = await import("../src/server/docx-layout.ts");
const { toFillValues } = await import("../src/server/source-map.ts");

async function docxFromFixture(name) {
  const xml = readFileSync(join(FIX, name), "utf8");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    readFileSync(join(FIX, "content-types.xml"), "utf8"),
  );
  zip.folder("_rels")?.file(
    ".rels",
    readFileSync(join(FIX, "rels.xml"), "utf8"),
  );
  zip.folder("word")?.file("document.xml", xml);
  zip
    .folder("word")
    ?.folder("_rels")
    ?.file(
      "document.xml.rels",
      readFileSync(join(FIX, "document.xml.rels"), "utf8"),
    );
  return Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

async function plainTextFromDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml").async("string");
  return (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
    .map((t) => t.replace(/<\/?w:t[^>]*>/g, ""))
    .join("");
}

console.log("table-cell-fields-unit-test");
assert.ok(existsSync(FIXTURE), `missing fixture ${FIXTURE}`);

{
  const buf = readFileSync(FIXTURE);
  const { fields } = await parseTemplate(buf);
  const expected = ["ชื่อผู้ติดต่อ", "เบอร์โทร", "อีเมล", "หมายเหตุ"];
  const names = fields.map((f) => f.name);
  for (const n of expected) {
    assert.ok(names.includes(n), `missing field ${n}`);
    const f = fields.find((x) => x.name === n);
    assert.equal(f.type, "text");
    assert.ok(f.location, `field ${n} should have location`);
    assert.equal(typeof f.location.tableIndex, "number");
    assert.equal(typeof f.location.rowIndexInTable, "number");
    assert.equal(typeof f.location.cellIndex, "number");
  }
  const layout = await extractDocumentLayout(buf);
  const staticTable = layout.blocks.find(
    (b) => b.type === "table" && Array.isArray(b.staticRows) && b.staticRows.length,
  );
  assert.ok(staticTable, "expected a non-loop static table");
  assert.equal(staticTable.listName, undefined);
  const cellTags = [];
  for (const row of staticTable.staticRows) {
    for (const cell of row) {
      if (cell.tags?.length) cellTags.push(...cell.tags);
      for (const t of extractSelfTagsFromCellText(cell.text)) {
        assert.ok(cell.tags?.includes(t), `tags[] should include ${t}`);
        assert.ok(
          cell.fieldName === t || (cell.tags || []).includes(t),
          `cell should expose fieldName or tags for ${t}`,
        );
      }
      if (cell.tags?.length === 1) {
        assert.equal(cell.fieldName, cell.tags[0]);
      }
    }
  }
  for (const n of expected) {
    assert.ok(cellTags.includes(n), `layout cell tags missing ${n}`);
  }
  console.log("✓ fixture fields have location; staticRows carry fieldName/tags");
}

{
  const buf = readFileSync(FIXTURE);
  const { fields } = await parseTemplate(buf);
  const values = {
    สถานที่ทำสัญญา: "กรุงเทพ",
    วันที่ทำสัญญา: "1 ม.ค. 2569",
    ชื่อผู้กู้: "สมชาย",
    อายุผู้กู้: "30",
    ที่อยู่ผู้กู้: "1/1",
    ชื่อผู้ให้กู้: "สมหญิง",
    จำนวนเงิน: "1000",
    จำนวนเงินตัวอักษร: "หนึ่งพันบาท",
    วันครบกำหนด: "1 ก.พ. 2569",
    ชื่อผู้ติดต่อ: "ติดต่อ A",
    เบอร์โทร: "0812345678",
    อีเมล: "a@example.com",
    หมายเหตุ: "note-ok",
  };
  const filled = await fillTemplate({
    template: buf,
    values: toFillValues(fields, values, {}, {}),
    images: [],
  });
  const text = await plainTextFromDocx(filled);
  assert.match(text, /ติดต่อ A/);
  assert.match(text, /0812345678/);
  assert.match(text, /a@example\.com/);
  assert.match(text, /note-ok/);
  assert.doesNotMatch(text, /\{\{ชื่อผู้ติดต่อ\}\}/);
  assert.doesNotMatch(text, /\{\{เบอร์โทร\}\}/);

  const skipped = await fillTemplate({
    template: buf,
    values: toFillValues(
      fields,
      values,
      {
        ชื่อผู้ติดต่อ: true,
        เบอร์โทร: true,
        อีเมล: true,
        หมายเหตุ: true,
      },
      {},
    ),
    images: [],
  });
  const skippedText = await plainTextFromDocx(skipped);
  assert.doesNotMatch(skippedText, /\{\{ชื่อผู้ติดต่อ\}\}/);
  assert.doesNotMatch(skippedText, /\{\{เบอร์โทร\}\}/);
  assert.doesNotMatch(skippedText, /\{\{อีเมล\}\}/);
  assert.doesNotMatch(skippedText, /\{\{หมายเหตุ\}\}/);
  assert.doesNotMatch(skippedText, /ติดต่อ A/);
  console.log("✓ fill writes values into table cells; skip leaves no raw tags");
}

{
  const template = await docxFromFixture("slash-and-loop.xml");
  const { fields } = await parseTemplate(template);
  const list = fields.find((f) => f.type === "list");
  assert.ok(list, "expected a list/loop field");
  const filled = await fillTemplate({
    template,
    values: toFillValues(fields, { [list.name]: [] }, {}, {}),
    images: [],
  });
  const text = await plainTextFromDocx(filled);
  assert.doesNotMatch(text, /\{\{#/);
  assert.doesNotMatch(text, /\{\{\//);
  console.log("✓ loop tables still parse + fill (regression)");
}

console.log("\ntable-cell-fields-unit-test: ok");
