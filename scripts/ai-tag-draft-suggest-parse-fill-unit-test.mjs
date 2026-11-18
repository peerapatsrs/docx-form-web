#!/usr/bin/env node
/**
 * Suggest → tagTemplate → parseTemplate → fillTemplate roundtrip.
 * Guards against unclosed {{#…}} table loops (real-AI gate blocker) and
 * ensures structural fixtures (VEGA/LYRA-style leftover + blank + multi-header)
 * stay parseable after AI draft enrich.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const FIX_AI = join(root, "fixtures/ai-tag-draft");
const FIX_TAG = join(root, "fixtures/tag-parse");

const { validateAiTagSuggestions } = await import(
  "../src/server/ai-tag-draft.ts"
);
const { tagTemplate } = await import("../src/server/template-tagger.ts");
const { parseTemplate, fillTemplate } = await import(
  "../src/server/docx-engine.ts"
);
const { toFillValues } = await import("../src/server/source-map.ts");

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

async function docxFromXml(xml) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    readFileSync(join(FIX_TAG, "content-types.xml"), "utf8"),
  );
  zip.folder("_rels")?.file(
    ".rels",
    readFileSync(join(FIX_TAG, "rels.xml"), "utf8"),
  );
  zip.folder("word")?.file("document.xml", xml);
  zip
    .folder("word")
    ?.folder("_rels")
    ?.file(
      "document.xml.rels",
      readFileSync(join(FIX_TAG, "document.xml.rels"), "utf8"),
    );
  return Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

async function readDocTags(buf) {
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file("word/document.xml").async("string");
  const opens = [...doc.matchAll(/\{\{#[^{}]*\}\}/g)].map((m) => m[0]);
  const closes = [...doc.matchAll(/\{\{\/[^{}]*\}\}/g)].map((m) => m[0]);
  const all = [...doc.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]);
  return { opens, closes, all, doc };
}

function opsFromSuggestions(suggestions) {
  return suggestions.map((s, i) => ({
    id: `t${i}`,
    plainText: s.plainText,
    occurrence: s.occurrence ?? 0,
    plainStart: s.plainStart,
    tag: s.tag,
    mode: s.mode,
    closeTag:
      s.closeTag ||
      (s.mode === "wrap-row" || s.mode === "wrap" ? "{{/}}" : undefined),
    cellIndex: s.cellIndex,
    wrapTag: s.wrapTag,
    wrapOccurrence: s.wrapOccurrence,
    tableIndex: s.tableIndex,
    rowIndexInTable: s.rowIndexInTable,
  }));
}

async function roundtrip({ name, xmlName, plain, seed = [] }) {
  const xmlPath = join(FIX_AI, xmlName);
  assert.ok(existsSync(xmlPath), `missing ${xmlName}`);
  const xml = readFileSync(xmlPath, "utf8");
  const suggestions = validateAiTagSuggestions(plain, seed, xml, "th");
  const wraps = suggestions.filter(
    (s) => s.mode === "wrap-row" || s.mode === "wrap",
  );
  assert.ok(
    wraps.every((w) => w.closeTag === "{{/}}" || w.closeTag === `{{/${w.name}}}`),
    `${name}: every wrap suggestion must carry a closeTag`,
  );
  const buf = await docxFromXml(xml);
  const tagged = await tagTemplate(buf, opsFromSuggestions(suggestions));
  const { opens, closes, all } = await readDocTags(tagged.buffer);
  assert.equal(
    opens.length,
    closes.length,
    `${name}: openers (${opens.length}) != closers (${closes.length}) tags=${all.join(" ")}`,
  );
  if (wraps.some((w) => w.mode === "wrap-row")) {
    assert.ok(
      opens.length >= 1,
      `${name}: expected at least one table loop opener after tagTemplate`,
    );
  }
  const parsed = await parseTemplate(tagged.buffer);
  assert.ok(parsed.fields?.length, `${name}: parse must yield fields`);
  const ui = {};
  for (const f of parsed.fields) {
    if (f.type === "list") {
      const row = {};
      for (const it of f.itemFields || []) {
        row[it.name] = it.type === "bool" ? true : it.type === "auto" ? 1 : "x";
      }
      ui[f.name] = [row];
    } else if (f.type === "bool") {
      ui[f.name] = true;
    } else {
      ui[f.name] = "x";
    }
  }
  const values = toFillValues(parsed.fields, ui, {}, {});
  const filled = await fillTemplate({
    template: tagged.buffer,
    values,
    images: [],
  });
  assert.ok(filled?.length > 0, `${name}: fill must produce a buffer`);
  const filledXml = await (
    await JSZip.loadAsync(filled)
  )
    .file("word/document.xml")
    .async("string");
  assert.doesNotMatch(
    filledXml,
    /\{\{#[^{}]*\}\}/,
    `${name}: filled doc must not leave open loop tags`,
  );
}

console.log("ai-tag-draft-suggest-parse-fill-unit-test");

const values = JSON.parse(
  readFileSync(join(FIX_AI, "values.json"), "utf8"),
);

await check("leftover sample rows (VEGA/LYRA-style) suggest→parse→fill", async () => {
  await roundtrip({
    name: "leftover",
    xmlName: "leftover-sample-rows.xml",
    plain: "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300Total600",
  });
});

await check("blank template table suggest→parse→fill", async () => {
  await roundtrip({
    name: "blank",
    xmlName: "blank-table.xml",
    plain: "ลำดับรายการจำนวน------",
  });
});

await check("multi-header table suggest→parse→fill", async () => {
  await roundtrip({
    name: "multi",
    xmlName: "multi-header.xml",
    plain: values.multiHeader.plain,
    seed: values.multiHeader.suggestions || [],
  });
});

await check("thai totals/baht/note tagged and parse→fill", async () => {
  const xml = readFileSync(join(FIX_AI, "thai-totals-table.xml"), "utf8");
  const plain =
    "ลำดับรายการจำนวนเงิน1AlphaWidget1002BetaWidget200รวมเงิน1200หนึ่งพันสองร้อยบาท(บาทถ้วน)";
  const suggestions = validateAiTagSuggestions(plain, [], xml, "th");
  assert.ok(
    suggestions.some((s) => s.plainText === "1200"),
    "รวมเงิน amount 1200 must be tagged",
  );
  assert.ok(
    suggestions.some((s) => s.plainText === "หนึ่งพันสองร้อยบาท"),
    "baht-text must be tagged",
  );
  assert.ok(
    suggestions.some((s) => s.plainText === "(บาทถ้วน)" || s.plainText === "บาทถ้วน"),
    "parenthetical note must be tagged",
  );
  await roundtrip({
    name: "thai-totals",
    xmlName: "thai-totals-table.xml",
    plain,
  });
});

await check("blank checkbox table: wrap + ordinal + bool, parse→fill", async () => {
  const xml = readFileSync(join(FIX_AI, "blank-checkbox-table.xml"), "utf8");
  const plain = "ลำดับรายการเลือกยืนยัน--☐☐--☐☐";
  const suggestions = validateAiTagSuggestions(plain, [], xml, "th");
  assert.ok(
    suggestions.some((s) => s.mode === "wrap-row"),
    "blank checkbox table must wrap",
  );
  assert.ok(
    suggestions.some(
      (s) =>
        s.cellIndex === 0 &&
        (s.kind === "auto" || String(s.tag || "").includes("+")),
    ),
    "first column ordinal {{+…}}",
  );
  const bools = suggestions.filter((s) => s.kind === "bool");
  assert.ok(bools.length >= 2, `expected >=2 bool checkbox fields got ${bools.length}`);
  assert.ok(
    !suggestions.some(
      (s) =>
        s.kind === "text" &&
        (s.plainText === "☐" || s.plainText === "☑" || s.plainText === "✓"),
    ),
    "checkboxes must not become text fields",
  );
  await roundtrip({
    name: "blank-checkbox",
    xmlName: "blank-checkbox-table.xml",
    plain,
  });
});

await check("fill-empty after wrap-row cannot leave unclosed openers", async () => {
  // Regression: fill-empty-tc used to wipe {{/}} on the last prototype cell.
  const xml = readFileSync(join(FIX_AI, "multi-header.xml"), "utf8");
  const suggestions = validateAiTagSuggestions(
    values.multiHeader.plain,
    values.multiHeader.suggestions || [],
    xml,
    "th",
  );
  assert.ok(
    suggestions.some((s) => s.mode === "fill-empty-tc"),
    "fixture must exercise fill-empty-tc",
  );
  const tagged = await tagTemplate(
    await docxFromXml(xml),
    opsFromSuggestions(suggestions),
  );
  const { opens, closes } = await readDocTags(tagged.buffer);
  assert.equal(opens.length, closes.length);
  await parseTemplate(tagged.buffer);
});

if (failed) {
  console.error(`ai-tag-draft-suggest-parse-fill-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-tag-draft-suggest-parse-fill-unit-test: ok");
