#!/usr/bin/env node
/**
 * After list-table wrap-row, leftover sample rows become delete-tr;
 * summary/total rows are kept.
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

async function load() {
  const url =
    pathToFileURL(join(root, "src/server/ai-tag-draft.ts")).href +
    `?t=${Date.now()}-${Math.random()}`;
  return import(url);
}

const xml = readFileSync(join(fixturesDir, "leftover-sample-rows.xml"), "utf8");
const plain =
  "NoItemAmt1AlphaWidget1002BetaWidget2003GammaWidget300Total600";

console.log("ai-tag-draft-leftover-rows-unit-test");

await check("detectRunSequenceColumns from sequential integers", async () => {
  const { detectRunSequenceColumns, columnLooksLikeRunSequence } = await load();
  const rows = [
    { cells: [{ text: "1" }, { text: "AlphaWidget" }, { text: "100" }] },
    { cells: [{ text: "2" }, { text: "BetaWidget" }, { text: "200" }] },
    { cells: [{ text: "3" }, { text: "GammaWidget" }, { text: "300" }] },
  ];
  assert.equal(columnLooksLikeRunSequence(rows, 0), true);
  assert.equal(columnLooksLikeRunSequence(rows, 2), false, "amounts not sequential from 0/1");
  const cols = detectRunSequenceColumns(rows);
  assert.ok(cols.has(0));
  assert.ok(!cols.has(2));
});

await check("validate emits delete-tr for leftover sample rows", async () => {
  const { validateAiTagSuggestions } = await load();
  const out = validateAiTagSuggestions(
    plain,
    [
      {
        plainText: "1AlphaWidget100",
        name: "item_rows",
        kind: "list-table",
        mode: "wrap-row",
      },
    ],
    xml,
    "en",
  );

  const wrap = out.find((s) => s.kind === "list-table" || s.mode === "wrap-row");
  assert.ok(wrap, "prototype wrap present");

  const deletes = out.filter((s) => s.mode === "delete-tr" || s.kind === "delete-tr");
  assert.ok(deletes.length >= 2, `expected ≥2 delete-tr, got ${deletes.length}`);
  assert.ok(
    deletes.every(
      (d) =>
        typeof d.tableIndex === "number" &&
        typeof d.rowIndexInTable === "number" &&
        d.rowIndexInTable > 0,
    ),
  );
  // Total row must NOT be deleted.
  assert.ok(
    !deletes.some((d) => String(d.plainText || "").includes("Total")),
    "summary row must stay",
  );
  // Later sample tokens should not be tagged as replace fields.
  assert.ok(!out.some((s) => s.plainText === "BetaWidget" && s.mode === "replace"));
  assert.ok(!out.some((s) => s.plainText === "GammaWidget" && s.mode === "replace"));
});

await check("looksLikeRunSequence uses isRunColumn, not Thai keywords", async () => {
  const { looksLikeRunSequence } = await load();
  assert.equal(
    looksLikeRunSequence({
      header: "ลำดับ",
      cellIndex: 1,
      cellText: "1",
      isRunColumn: null,
    }),
    false,
    "Thai caption alone must not force auto on non-run columns",
  );
  assert.equal(
    looksLikeRunSequence({
      header: "ลำดับ",
      cellIndex: 0,
      cellText: "1",
      isRunColumn: true,
    }),
    true,
  );
  assert.equal(
    looksLikeRunSequence({
      header: "จำเลยที่",
      cellIndex: 0,
      cellText: "1",
      isRunColumn: false,
    }),
    false,
  );
  assert.equal(
    looksLikeRunSequence({
      header: "No",
      cellIndex: 0,
      cellText: "1",
      isRunColumn: null,
    }),
    true,
    "Latin No. marker still a weak signal when column unknown",
  );
});

if (failed) {
  console.error(`ai-tag-draft-leftover-rows-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-tag-draft-leftover-rows-unit-test: ok");
