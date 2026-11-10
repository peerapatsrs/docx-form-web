#!/usr/bin/env node
/**
 * Generate/fill: skipped fields + empty loop tables leave no leftover {{tags}}.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const FIX = join(root, "fixtures", "tag-parse");

const {
  fillTemplate,
  parseTemplate,
} = await import("../src/server/docx-engine.ts");
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

async function readDocXml(buf) {
  const zip = await JSZip.loadAsync(buf);
  return zip.file("word/document.xml").async("string");
}

console.log("fill-skip-unit-test");

{
  const template = await docxFromFixture("slash-and-loop.xml");
  const parsed = await parseTemplate(template);
  const list = parsed.fields.find((f) => f.type === "list");
  assert.ok(list, "fixture must expose a list field");
  const text = parsed.fields.find((f) => f.type === "text");
  assert.ok(text, "fixture must expose a text field");

  // All skipped → empty string + empty loop
  const skipped = toFillValues(
    parsed.fields,
    { [text.name]: "ignored", [list.name]: [{ [list.itemFields[0].name]: "x" }] },
    { [text.name]: true, [list.name]: true },
    {},
  );
  assert.equal(skipped[text.name], "");
  assert.deepEqual(skipped[list.name], []);

  const outSkip = await fillTemplate({
    template,
    values: skipped,
    images: [],
  });
  const xmlSkip = await readDocXml(outSkip);
  assert.doesNotMatch(xmlSkip, /\{\{/);
  assert.doesNotMatch(xmlSkip, /\}\}/);
  console.log("✓ skip all fields → no leftover tags");

  // Empty loop without skip map
  const emptyLoop = {
    [text.name]: "ที่อยู่ทดสอบ",
    [list.name]: [],
  };
  const outEmpty = await fillTemplate({
    template,
    values: emptyLoop,
    images: [],
  });
  const xmlEmpty = await readDocXml(outEmpty);
  assert.match(xmlEmpty, /ที่อยู่ทดสอบ/);
  assert.doesNotMatch(xmlEmpty, /\{\{/);
  assert.doesNotMatch(xmlEmpty, /\{\{#/);
  console.log("✓ empty loop table [] → no leftover loop tags");

  // Legacy: FE still pre-transforms skip → "" / [] and may omit skip/rowSkip maps.
  // Backend must accept those values without requiring the maps.
  const legacyPreTransformed = {
    [text.name]: "",
    [list.name]: [],
  };
  const outLegacy = await fillTemplate({
    template,
    values: legacyPreTransformed,
    images: [],
  });
  const xmlLegacy = await readDocXml(outLegacy);
  assert.doesNotMatch(xmlLegacy, /\{\{/);
  assert.doesNotMatch(xmlLegacy, /\}\}/);
  console.log("✓ legacy pre-transformed values (no skip maps) → no leftover tags");

  // Preferred: raw values + skip/rowSkip maps (FE now also sends these).
  const withMaps = toFillValues(
    parsed.fields,
    {
      [text.name]: "ยังมีข้อความ",
      [list.name]: [{ [list.itemFields[0].name]: "row" }],
    },
    { [text.name]: true, [list.name]: true },
    {},
  );
  assert.equal(withMaps[text.name], "");
  assert.deepEqual(withMaps[list.name], []);
  const outMaps = await fillTemplate({
    template,
    values: withMaps,
    images: [],
  });
  assert.doesNotMatch(await readDocXml(outMaps), /\{\{/);
  console.log("✓ skip/rowSkip maps path (preferred) → no leftover tags");
}

{
  // sample-quote.docx (real fixture in public/examples)
  const sample = readFileSync(join(root, "public/examples/sample-quote.docx"));
  const parsed = await parseTemplate(sample);
  const skipAll = {};
  const values = {};
  for (const f of parsed.fields) {
    skipAll[f.name] = true;
    if (f.type === "list") values[f.name] = [];
    else if (f.type === "bool") values[f.name] = false;
    else values[f.name] = "";
  }
  const fillVals = toFillValues(parsed.fields, values, skipAll, {});
  const out = await fillTemplate({
    template: sample,
    values: fillVals,
    images: [],
  });
  const xml = await readDocXml(out);
  // Text / loop tags must be gone from document text runs.
  assert.doesNotMatch(xml, /<w:t[^>]*>\{\{/);
  assert.doesNotMatch(xml, /\{\{#/);
  assert.doesNotMatch(xml, /\{\{\//);
  // Loop body rows removed (header row may remain).
  assert.doesNotMatch(xml, /\{\{สินค้า\}\}|\{\{จำนวน\}\}|\{\{ราคา\}\}/);
  console.log("✓ sample-quote.docx skip-all → no leftover text/loop tags");
}

console.log("fill-skip-unit-test: ok");
