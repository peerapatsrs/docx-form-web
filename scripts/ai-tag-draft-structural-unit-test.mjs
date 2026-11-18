#!/usr/bin/env node
/**
 * Structural (keyword-free) helpers: row shapes, bool invert, whole-row wrap,
 * coverage estimate, paragraph-list shape detection.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const fixturesDir = join(root, "fixtures", "ai-tag-draft");

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

async function loadDraft() {
  return import(
    pathToFileURL(join(root, "src/server/ai-tag-draft.ts")).href +
      `?t=${Date.now()}-${Math.random()}`
  );
}
async function loadTagger() {
  return import(
    pathToFileURL(join(root, "src/server/template-tagger.ts")).href +
      `?t=${Date.now()}-${Math.random()}`
  );
}

console.log("ai-tag-draft-structural-unit-test");

await check("tableRowShapeSignature distinguishes sample vs total", async () => {
  const { tableRowShapeSignature, tableRowsSameSampleShape } = await loadDraft();
  const sample = [
    { text: "1" },
    { text: "AlphaWidget" },
    { text: "100" },
  ];
  const sample2 = [
    { text: "2" },
    { text: "BetaWidget" },
    { text: "200" },
  ];
  const total = [{ text: "" }, { text: "Total" }, { text: "600" }];
  const spare = [{ text: "title-deed" }, { text: "-" }, { text: "" }];
  assert.equal(tableRowShapeSignature(sample), tableRowShapeSignature(sample2));
  assert.ok(tableRowsSameSampleShape(sample, sample2));
  assert.ok(!tableRowsSameSampleShape(sample, total));
  assert.ok(!tableRowsSameSampleShape(sample, spare));
  // Single-cell sample vs totals line (same coarse "text" class, different structure).
  const scSample = [{ text: "1ItemAlpha1200unit" }];
  const scSample2 = [{ text: "2ItemBeta200unit" }];
  const scTotal = [
    { text: "Grand total           1,116one thousand one hundred sixteen" },
  ];
  assert.ok(tableRowsSameSampleShape(scSample, scSample2));
  assert.ok(!tableRowsSameSampleShape(scSample, scTotal));
});

await check("list-table wrap uses whole row plainText not lone digit", async () => {
  const { validateAiTagSuggestions } = await loadDraft();
  const xml = readFileSync(join(fixturesDir, "leftover-sample-rows.xml"), "utf8");
  const plain =
    "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300Total600";
  const out = validateAiTagSuggestions(
    plain,
    [
      {
        plainText: "1",
        name: "rows",
        kind: "list-table",
        mode: "wrap-row",
      },
    ],
    xml,
    "en",
  );
  const wrap = out.find((s) => s.kind === "list-table" || s.mode === "wrap-row");
  assert.ok(wrap, "wrap present");
  assert.ok(
    String(wrap.plainText).length > 1,
    `wrap plainText must be whole row, got ${JSON.stringify(wrap.plainText)}`,
  );
  assert.ok(
    typeof wrap.rowPlainStart === "number" &&
      typeof wrap.rowPlainEnd === "number" &&
      wrap.rowPlainEnd > wrap.rowPlainStart,
  );
  assert.ok(
    wrap.plainText.includes("AlphaWidget"),
    "whole-row wrap includes other cells",
  );
});

await check("shapeSignatureForList groups sequential siblings", async () => {
  const { shapeSignatureForList, leadingInteger, listParagraphListHints } =
    await loadTagger();
  assert.equal(
    shapeSignatureForList("Party 1 Name A"),
    shapeSignatureForList("Party 2 Name B"),
  );
  assert.equal(leadingInteger("Party 2 foo"), 2);

  const hints = listParagraphListHints(
    readFileSync(join(fixturesDir, "structural-para-list.xml"), "utf8"),
  );
  assert.ok(hints.length >= 1, `expected para list hint, got ${hints.length}`);
  assert.ok(hints[0].unitCount >= 2);
  assert.ok(
    !/จำเลย|โจทก์|defendant/i.test(
      hints[0].suggestedNameTh + hints[0].suggestedNameEn,
    ),
  );
});

await check("estimateSuggestCoverage marks sparse output thin", async () => {
  const { estimateSuggestCoverage, validateAiTagSuggestions } = await loadDraft();
  const xml = readFileSync(join(fixturesDir, "leftover-sample-rows.xml"), "utf8");
  const plain =
    "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300Total600";
  const thin = estimateSuggestCoverage([], plain, xml);
  assert.ok(thin.expected >= 4, `expected>=4 got ${thin.expected}`);
  assert.equal(thin.thin, true);

  const rich = validateAiTagSuggestions(plain, [], xml, "en");
  const cov = estimateSuggestCoverage(rich, plain, xml);
  assert.ok(cov.actual >= 3, `seeded actual ${cov.actual}`);
});

await check("no banned hardcoding markers in ai-tag-draft source", async () => {
  const src = readFileSync(join(root, "src/server/ai-tag-draft.ts"), "utf8");
  assert.doesNotMatch(src, /TH_HEADER_EN/);
  assert.doesNotMatch(src, /SUMMARY_FIELD_RE/);
  assert.doesNotMatch(src, /จำลยที่/);
  assert.doesNotMatch(src, /table_loop_/);
  assert.doesNotMatch(src, /\\bno\\.\\?\\b/);
});

if (failed) {
  console.error(`ai-tag-draft-structural-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-tag-draft-structural-unit-test: ok");
