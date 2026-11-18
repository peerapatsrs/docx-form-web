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

await check("whole-doc label-followed expected raises thin when empty", async () => {
  const { estimateSuggestCoverage, countLabelFollowedFillables } = await loadDraft();
  const plain =
    "Company\t\tAcme Holdings Ltd\nTel\t\t02-000-0000\nAddress\t\t123 Main Road";
  assert.ok(countLabelFollowedFillables(plain) >= 2);
  const cov = estimateSuggestCoverage([], plain, null);
  assert.ok(cov.expected >= 2, `expected>=2 got ${cov.expected}`);
  assert.equal(cov.thin, true);
});

await check("never name from cell value; reject equals source", async () => {
  const { nameFromHeaderOrLabel, nameEqualsSourceValue, validateAiTagSuggestions } =
    await loadDraft();
  assert.equal(nameEqualsSourceValue("ผ่าน", "ผ่าน"), true);
  assert.equal(nameFromHeaderOrLabel(null, null, "th", "ผ่าน"), null);
  assert.equal(nameFromHeaderOrLabel("สถานะ", null, "th", "ผ่าน"), "สถานะ");
  const xml = readFileSync(join(fixturesDir, "leftover-sample-rows.xml"), "utf8");
  const plain =
    "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300Total600";
  const out = validateAiTagSuggestions(
    plain,
    [
      {
        plainText: "1AlphaWidget100",
        name: "rows",
        kind: "list-table",
        mode: "wrap-row",
      },
      {
        plainText: "AlphaWidget",
        name: "AlphaWidget",
        kind: "text",
        mode: "replace",
        label: "Item",
      },
    ],
    xml,
    "en",
  );
  assert.ok(
    !out.some((s) => s.mode === "replace" && s.name === "AlphaWidget"),
    "name equal to cell value must be rejected or replaced",
  );
  assert.ok(
    out.some(
      (s) =>
        s.plainText === "AlphaWidget" &&
        s.mode === "replace" &&
        s.name !== "AlphaWidget",
    ),
    "cell still tagged from header",
  );
});

await check("garbled near-duplicate token names rejected", async () => {
  const { looksLikeGarbledName } = await loadDraft();
  assert.equal(looksLikeGarbledName("foo_foo"), true);
  assert.equal(looksLikeGarbledName("pass_pass_status"), true);
  assert.equal(looksLikeGarbledName("abababxx"), true);
  assert.equal(looksLikeGarbledName("item_amount"), false);
  assert.equal(looksLikeGarbledName("☐"), true, "checkbox arm alone");
  assert.equal(looksLikeGarbledName("lbl_27qmif"), true, "legacy hash fallback name");
  assert.equal(looksLikeGarbledName("f_27qmif"), false, "stable f_ hash is allowed");
  assert.equal(looksLikeGarbledName("จำนวน_รวมทั้งสิ้น_1116"), true, "sample+digits");
  assert.equal(looksLikeGarbledName("amt_total"), false);
});

await check("coverage warns when ~27 tags on ~50 expected", async () => {
  const { estimateSuggestCoverage } = await loadDraft();
  // Synthetic large-doc that structurally expects ~50 fillables.
  const parts = [];
  for (let i = 1; i <= 32; i += 1) {
    parts.push(`FieldCaption${i}\t\tSampleFillValue${i}Extra`);
  }
  for (let i = 0; i < 8; i += 1) {
    parts.push(`02-10${i}-222${i}`);
  }
  parts.push(
    "user@example.com",
    "other@example.org",
    "ops@example.org",
  );
  parts.push(
    "1234567890123",
    "9876543210987",
    "1-2345-67890-12-1",
    "5555566666777",
  );
  parts.push("1,116.00", "2,500.50", "10,000");
  const plain = parts.join("\n");
  const fakeSuggestions = Array.from({ length: 27 }, (_, i) => ({
    plainText: `SampleFillValue${(i % 32) + 1}Extra`,
    occurrence: 0,
    plainStart: i,
    name: `field_${i}`,
    kind: "text",
    tag: `{{field_${i}}}`,
    mode: "replace",
  }));
  const cov = estimateSuggestCoverage(fakeSuggestions, plain, null);
  assert.ok(cov.expected >= 50, `expected>=50 got ${cov.expected}`);
  assert.ok(cov.actual === 27, `actual=27 got ${cov.actual}`);
  assert.ok(cov.score < 0.85, `score<0.85 got ${cov.score}`);
  assert.equal(cov.thin, true, "27-on-~50 output must warn thin");
});

await check("chunk helpers: smaller default + timeout floor", async () => {
  const {
    DEFAULT_AI_SUGGEST_CHUNK_CHARS,
    DEFAULT_AI_SUGGEST_CHUNK_RETRY,
    DEFAULT_AI_SUGGEST_OVERALL_MS,
    DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS,
    getAiSuggestChunkConcurrency,
    getAiSuggestChunkRetry,
    getAiSuggestChunkTimeoutMs,
    getAiSuggestCallTimeoutMs,
    getAiSuggestOverallBudgetMs,
    splitPlainTextChunks,
  } = await loadDraft();
  assert.ok(DEFAULT_AI_SUGGEST_CHUNK_CHARS <= 20_000);
  assert.equal(getAiSuggestChunkConcurrency(), 1);
  assert.equal(getAiSuggestChunkRetry(), DEFAULT_AI_SUGGEST_CHUNK_RETRY);
  assert.ok(DEFAULT_AI_SUGGEST_CHUNK_RETRY >= 1);
  assert.equal(DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS, 120_000);
  assert.equal(getAiSuggestChunkTimeoutMs(90_000), 90_000, "shorter preferred honored");
  assert.ok(getAiSuggestChunkTimeoutMs(180_000) <= 120_000, "hard per-call cap 120s");
  assert.equal(getAiSuggestCallTimeoutMs(90_000), getAiSuggestChunkTimeoutMs(90_000));
  assert.ok(DEFAULT_AI_SUGGEST_OVERALL_MS <= 300_000);
  assert.ok(getAiSuggestOverallBudgetMs(90_000) <= 300_000);
  const chunks = splitPlainTextChunks("x".repeat(50_000), 16_000);
  assert.ok(chunks.length >= 3, `expected >=3 chunks got ${chunks.length}`);
  // Small doc (<16k) stays a single chunk — timeout helpers still apply.
  const small = splitPlainTextChunks("y".repeat(8_000), 16_000);
  assert.equal(small.length, 1, "doc under 16k is one call");
  assert.equal(getAiSuggestCallTimeoutMs(), 120_000, "default per-call is 120s");
});

await check("blank sample clones are deleted not kept as trailer", async () => {
  const { isBlankSampleCloneRow, findTrailingFixedRowStart, shouldDeleteLaterSampleRow } =
    await loadDraft();
  const proto = [
    { text: "1" },
    { text: "AlphaWidget" },
    { text: "100" },
  ];
  const blank = [{ text: "" }, { text: "" }, { text: "" }];
  const ordinalOnly = [{ text: "4" }, { text: "" }, { text: "" }];
  assert.equal(isBlankSampleCloneRow(proto, blank), true);
  assert.equal(isBlankSampleCloneRow(proto, ordinalOnly), true);
  const later = [
    { rowIndexInTable: 2, cells: [{ text: "2" }, { text: "Beta" }, { text: "200" }] },
    { rowIndexInTable: 3, cells: blank },
    { rowIndexInTable: 4, cells: ordinalOnly },
    { rowIndexInTable: 5, cells: [{ text: "" }, { text: "Total" }, { text: "900" }] },
  ];
  // Blank clones must not pull the trailer start earlier (would shrink 5→3 wrongly).
  const start = findTrailingFixedRowStart(proto, later);
  assert.equal(start, 5, `trailer at Total got ${start}`);
  assert.equal(
    shouldDeleteLaterSampleRow(proto, blank, { isAtTableEnd: false, isNearEnd: true }),
    true,
  );
});

await check("garbled rejects short/dotted/degenerate structural names", async () => {
  const { looksLikeGarbledName } = await loadDraft();
  assert.equal(looksLikeGarbledName("ที่"), true, "particle-length");
  assert.equal(looksLikeGarbledName("ที่ทัที่_ที่"), true, "tiny-part dump");
  assert.equal(looksLikeGarbledName("จำเลยที่.1"), true, "dotted numeric");
  assert.equal(looksLikeGarbledName("ราคา.2"), true, "dotted numeric");
  assert.equal(looksLikeGarbledName("จำเลยที่.id"), true, "dotted id");
  assert.equal(looksLikeGarbledName("รายการค่าใช้จ่าย"), false);
  assert.equal(looksLikeGarbledName("เมืองปทุมธานี"), false);
});

await check("blank template table wraps prototype row with fill-empty cells", async () => {
  const { validateAiTagSuggestions, looksLikeGarbledName } = await loadDraft();
  const xml = readFileSync(join(fixturesDir, "blank-table.xml"), "utf8");
  const plain = "ลำดับรายการจำนวน------";
  const out = validateAiTagSuggestions(plain, [], xml, "th");
  const wrap = out.find((s) => s.mode === "wrap-row" && s.kind === "list-table");
  assert.ok(wrap, "blank table must seed wrap-row");
  assert.match(String(wrap.tag || ""), /^\{\{#/);
  assert.equal(out.filter((s) => s.kind === "list").length, 0, "no stray paragraph loop");
  const fills = out.filter((s) => s.mode === "fill-empty-tc");
  assert.ok(fills.length >= 3, `expected >=3 fill-empty-tc got ${fills.length}`);
  assert.equal(
    new Set(fills.map((s) => s.name)).size,
    fills.length,
    "prototype cells must have unique names",
  );
  assert.ok(
    fills.some((s) => s.cellIndex === 0 && (s.kind === "auto" || String(s.tag || "").includes("+"))),
    "blank first column must be ordinal {{+…}}",
  );
  assert.ok(!/\//.test(String(wrap.name || "")), "loop name must not contain /");
  assert.ok(
    !out.some((s) => looksLikeGarbledName(String(s.name || ""))),
    "no degenerate field names",
  );
});

await check("no keyword denylist or ลำดับ default in ai-tag-draft source", async () => {
  const src = readFileSync(join(root, "src/server/ai-tag-draft.ts"), "utf8");
  assert.doesNotMatch(
    src,
    /\/\^\(รายการ\|ค่า\|value\|rows\|loop\)\$\/iu/,
  );
  assert.doesNotMatch(src, /resolveVarName\(\s*lang\s*===\s*["']en["']\s*\?\s*["']no["']\s*:\s*["']ลำดับ["']/);
  assert.doesNotMatch(src, /SAMPLE_MARKER_RE/);
  assert.doesNotMatch(src, /GLUED_STEM_LABELS/);
  assert.doesNotMatch(
    src,
    /resolveVarName\(\s*lang\s*===\s*["']en["']\s*\?\s*["']phone["']\s*:\s*["']โทรศัพท์["']/,
  );
  assert.doesNotMatch(
    src,
    /resolveVarName\(\s*lang\s*===\s*["']en["']\s*\?\s*["']email["']\s*:\s*["']อีเมล["']/,
  );
  assert.doesNotMatch(src, /ตัวอย่าง\|sample\|example\|demo/);
});

await check("VAT rate caption is never tagged as a field", async () => {
  const { validateAiTagSuggestions } = await loadDraft();
  const xml = readFileSync(join(fixturesDir, "leftover-sample-rows.xml"), "utf8");
  const plain =
    "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300รวมเงิน1200ภาษีมูลค่าเพิ่ม (7%)84บาทหนึ่งพันสองร้อยบาทถ้วน";
  const out = validateAiTagSuggestions(
    plain,
    [
      {
        plainText: "1AlphaWidget100",
        name: "rows",
        kind: "list-table",
        mode: "wrap-row",
      },
      {
        plainText: "ภาษีมูลค่าเพิ่ม (7%)",
        name: "รายการ",
        kind: "text",
        mode: "replace",
      },
      {
        plainText: "1200",
        name: "รวมเงิน",
        kind: "text",
        mode: "replace",
        label: "รวมเงิน",
      },
    ],
    xml,
    "th",
  );
  assert.ok(
    !out.some((s) => s.plainText.includes("ภาษีมูลค่าเพิ่ม")),
    "VAT label stays static",
  );
  assert.ok(
    !out.some(
      (s) =>
        s.mode !== "wrap-row" &&
        s.mode !== "delete-tr" &&
        s.name === "รายการ",
    ),
    "bare รายการ scalar rejected",
  );
});

await check("totals/baht/note values are tagged; rate captions stay static", async () => {
  const { validateAiTagSuggestions, looksLikeFillValue } = await loadDraft();
  const xml = readFileSync(join(fixturesDir, "leftover-sample-rows.xml"), "utf8");
  const plain = "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300Total600";
  assert.equal(looksLikeFillValue("Total"), false, "Title Case label is not a fill value");
  assert.equal(looksLikeFillValue("หนึ่งพันสองร้อยบาท"), true, "baht-text is fill");
  assert.equal(looksLikeFillValue("(บาทถ้วน)"), true, "parenthetical note is fill");
  const out = validateAiTagSuggestions(
    plain,
    [
      {
        plainText: "1AlphaWidget100",
        name: "rows",
        kind: "list-table",
        mode: "wrap-row",
      },
    ],
    xml,
    "th",
  );
  assert.ok(
    out.some((s) => s.mode === "replace" && s.plainText === "600" && s.name === "Total"),
    "Total amount 600 tagged from sibling label",
  );
  assert.ok(
    out.some((s) => s.mode === "replace" && s.plainText === "1" && s.kind === "auto"),
    "one-char runno cell tagged as auto",
  );
  assert.ok(
    out.some((s) => s.mode === "replace" && s.plainText === "AlphaWidget"),
    "name cell tagged",
  );
  assert.ok(
    out.some((s) => s.mode === "replace" && s.plainText === "100"),
    "amount cell tagged",
  );
});

await check("trailing fixed rows kept (VAT/total/note block)", async () => {
  const { findTrailingFixedRowStart, shouldDeleteLaterSampleRow, isSummaryLikeRow } =
    await loadDraft();
  const proto = [
    { text: "1" },
    { text: "AlphaWidget" },
    { text: "100" },
  ];
  const later = [
    { rowIndexInTable: 2, cells: [{ text: "2" }, { text: "BetaWidget" }, { text: "200" }] },
    { rowIndexInTable: 3, cells: [{ text: "" }, { text: "Subtotal" }, { text: "900" }] },
    { rowIndexInTable: 4, cells: [{ text: "" }, { text: "VAT" }, { text: "63" }] },
    { rowIndexInTable: 5, cells: [{ text: "" }, { text: "Total" }, { text: "963" }] },
    { rowIndexInTable: 6, cells: [{ text: "" }, { text: "Note line" }, { text: "" }] },
  ];
  const start = findTrailingFixedRowStart(proto, later);
  assert.equal(start, 3, `trailer starts at first summary got ${start}`);
  for (const row of later.filter((r) => r.rowIndexInTable >= start)) {
    assert.equal(
      shouldDeleteLaterSampleRow(proto, row.cells, {
        isAtTableEnd: row.rowIndexInTable === 6,
        isNearEnd: true,
      }),
      false,
      `keep trailer row ${row.rowIndexInTable}`,
    );
    assert.equal(
      isSummaryLikeRow(proto, row.cells, {
        isAtTableEnd: row.rowIndexInTable === 6,
        isNearEnd: true,
      }) ||
        !shouldDeleteLaterSampleRow(proto, row.cells, {
          isAtTableEnd: row.rowIndexInTable === 6,
          isNearEnd: true,
        }),
      true,
    );
  }
});

await check("scalar never shares loop name", async () => {
  const { validateAiTagSuggestions } = await loadDraft();
  const xml = readFileSync(join(fixturesDir, "leftover-sample-rows.xml"), "utf8");
  const plain = "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300Total600";
  const out = validateAiTagSuggestions(
    plain,
    [
      {
        plainText: "1AlphaWidget100",
        name: "item_rows",
        kind: "list-table",
        mode: "wrap-row",
      },
      {
        plainText: "600",
        name: "item_rows",
        kind: "text",
        mode: "replace",
      },
    ],
    xml,
    "en",
  );
  const wrap = out.find((s) => s.mode === "wrap-row");
  assert.ok(wrap, "wrap present");
  assert.ok(
    !out.some(
      (s) =>
        s.mode !== "wrap-row" &&
        s.mode !== "delete-tr" &&
        s.name === wrap.name,
    ),
    "no scalar shares loop name",
  );
});

await check("no banned hardcoding markers in ai-tag-draft source", async () => {
  const src = readFileSync(join(root, "src/server/ai-tag-draft.ts"), "utf8");
  assert.doesNotMatch(src, /TH_HEADER_EN/);
  assert.doesNotMatch(src, /SUMMARY_FIELD_RE/);
  assert.doesNotMatch(src, /จำลยที่/);
  assert.doesNotMatch(src, /table_loop_/);
  assert.doesNotMatch(src, /\\bno\\.\\?\\b/);
  assert.doesNotMatch(src, /resolveVarName\(.*cellText/);
  assert.doesNotMatch(src, /resolveVarName\(sampleText/);
  // Removed fixed fallbacks that produced junk names / empty loops.
  assert.doesNotMatch(src, /return\s+["']รายการ["']/);
  assert.doesNotMatch(src, /lang\s*===\s*["']en["']\s*\?\s*["']value["']/);
  assert.doesNotMatch(src, /\?\s*["']ค่า["']/);
  assert.doesNotMatch(src, /_ข้อความ/);
  assert.doesNotMatch(src, /blank_field/);
  assert.doesNotMatch(src, /ช่องว่าง/);
  assert.doesNotMatch(src, /คอลัมน์_/);
  assert.doesNotMatch(src, /col_\$\{/);
  assert.doesNotMatch(src, /return\s+["']จำนวน["']/);
});

if (failed) {
  console.error(`ai-tag-draft-structural-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-tag-draft-structural-unit-test: ok");
