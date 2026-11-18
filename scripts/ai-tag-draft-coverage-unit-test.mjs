#!/usr/bin/env node
/**
 * Coverage repair: sparse AI suggestions still get prototype cells tagged
 * deterministically from sample/empty hints (same input → same tag set).
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

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

console.log("ai-tag-draft-coverage-unit-test");

await check("sparse AI rows → coverage repair fills prototype cells", async () => {
  const { validateAiTagSuggestions } = await load();
  const values = JSON.parse(
    readFileSync(join(fixturesDir, "values.json"), "utf8"),
  );
  const tableFirst = values.tableFirstRow;
  const xml = readFileSync(join(fixturesDir, tableFirst.xml), "utf8");
  const plain = tableFirst.plain;

  const run = () =>
    validateAiTagSuggestions(
      plain,
      // Intentionally under-suggest: only a wrap, no cell fields.
      [
        {
          plainText: tableFirst.expected.prototypeCell
            ? `1${tableFirst.expected.prototypeCell}`
            : tableFirst.suggestionsTh.find((s) => s.kind === "list-table")
                ?.plainText,
          name: "row_loop",
          kind: "list-table",
          mode: "wrap-row",
        },
      ],
      xml,
      "th",
    );

  const a = run();
  const b = run();

  const wrapA = a.filter((s) => s.kind === "list-table" || s.mode === "wrap-row");
  assert.equal(wrapA.length, 1);

  const cellTagsA = a.filter(
    (s) =>
      (s.mode === "replace" || s.mode === "fill-empty-tc") &&
      typeof s.cellIndex === "number",
  );
  assert.ok(
    cellTagsA.length >= 2,
    `expected coverage repair to tag prototype cells, got ${cellTagsA.map((s) => s.tag).join(" | ")}`,
  );

  // Deterministic: same names/modes across runs.
  const sig = (rows) =>
    rows
      .map((s) => `${s.mode}:${s.kind}:${s.name}:${s.cellIndex ?? ""}:${s.plainText}`)
      .sort()
      .join("\n");
  assert.equal(sig(a), sig(b), "repeated validate must be deterministic");
});

await check("suggest temperature constant is 0 in source", async () => {
  const src = readFileSync(join(root, "src/server/ai-tag-draft.ts"), "utf8");
  assert.equal(
    (src.match(/temperature:\s*0\.1/g) || []).length,
    0,
    "no temperature 0.1 leftovers",
  );
  assert.ok(
    (src.match(/temperature:\s*0\b/g) || []).length >= 3,
    "suggest callers use temperature 0",
  );
});

if (failed) {
  console.error(`ai-tag-draft-coverage-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-tag-draft-coverage-unit-test: ok");
