#!/usr/bin/env node
/**
 * Bool fill contract: UI booleans + legacy arm-text (☐/√) must resolve correctly.
 * Posts the same shape the browser sends to /api/fill (values + skip maps).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const FIX = join(root, "fixtures", "tag-parse");

const { toFillValues, resolveBoolFormValue } = await import(
  pathToFileURL(join(root, "src/server/source-map.ts")).href + `?t=${Date.now()}`
);
const { fillTemplate, parseTemplate } = await import(
  "../src/server/docx-engine.ts"
);

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}

async function docxWithBool() {
  const xml = readFileSync(join(FIX, "bool-arms.xml"), "utf8");
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

console.log("fill-bool-arm-unit-test");

await check("resolveBoolFormValue: boolean + arm text", async () => {
  assert.equal(resolveBoolFormValue(true, "√", "☐"), true);
  assert.equal(resolveBoolFormValue(false, "√", "☐"), false);
  assert.equal(resolveBoolFormValue("☐", "√", "☐"), false);
  assert.equal(resolveBoolFormValue("√", "√", "☐"), true);
  assert.equal(resolveBoolFormValue("false", "√", "☐"), false);
  assert.equal(resolveBoolFormValue("", "√", "☐"), false);
});

await check("toFillValues: UI boolean false → ☐", async () => {
  const fields = [
    {
      name: "ok",
      type: "bool",
      trueText: "√",
      falseText: "☐",
      label: "ok",
    },
  ];
  // Exact browser contract after fix: real boolean + skip maps.
  const vals = toFillValues(fields, { ok: false }, {}, {});
  assert.equal(vals.ok, "☐");
  const valsOn = toFillValues(fields, { ok: true }, {}, {});
  assert.equal(valsOn.ok, "√");
});

await check("toFillValues: legacy UI arm-text ☐ is false", async () => {
  const fields = [
    {
      name: "ok",
      type: "bool",
      trueText: "√",
      falseText: "☐",
      label: "ok",
    },
  ];
  // Historical UI posted falseText as the value string.
  const vals = toFillValues(fields, { ok: "☐" }, {}, {});
  assert.equal(vals.ok, "☐");
  const valsOn = toFillValues(fields, { ok: "√" }, {}, {});
  assert.equal(valsOn.ok, "√");
});

await check("fillTemplate: UI-exact request with false boolean", async () => {
  const template = await docxWithBool();
  const parsed = await parseTemplate(template);
  const bool = parsed.fields.find((f) => f.type === "bool");
  assert.ok(bool, "fixture must expose bool field");
  assert.equal(bool.falseText, "☐");

  // Same shape createAllTemplatesZip / fillDocument send:
  // values = buildValuesPayloadFrom → { [name]: boolean }, plus skip maps.
  const uiValues = { [bool.name]: false };
  const uiSkip = {};
  const fillValues = toFillValues(parsed.fields, uiValues, uiSkip, {});
  assert.equal(fillValues[bool.name], "☐");

  const out = await fillTemplate({
    template,
    values: fillValues,
    images: [],
  });
  const xml = await readDocXml(out);
  assert.match(xml, /☐/);
  assert.doesNotMatch(xml, /√/);
  assert.doesNotMatch(xml, /\{\{/);
});

await check("fillTemplate: legacy arm-text ☐ request", async () => {
  const template = await docxWithBool();
  const parsed = await parseTemplate(template);
  const bool = parsed.fields.find((f) => f.type === "bool");
  const fillValues = toFillValues(
    parsed.fields,
    { [bool.name]: "☐" },
    {},
    {},
  );
  const out = await fillTemplate({
    template,
    values: fillValues,
    images: [],
  });
  const xml = await readDocXml(out);
  assert.match(xml, /☐/);
  assert.doesNotMatch(xml, /√/);
});

if (failed) {
  console.error(`fill-bool-arm-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("fill-bool-arm-unit-test: ok");
