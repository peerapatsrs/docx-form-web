#!/usr/bin/env node
/**
 * Regression: DEF-BE-DOCX-AI-SUGGEST-BAD-NAMES / INCOMPLETE naming rules.
 * Server-side normalize — no per-file hardcoding.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log("ai-tag-draft-name-quality-unit-test");

await check("stripJunkNumericSuffix peels _2/_3/_ก/_a collision noise", async () => {
  const { stripJunkNumericSuffix, looksLikeGarbledName } = await load();
  assert.equal(stripJunkNumericSuffix("zone_label_2"), "zone_label");
  assert.equal(stripJunkNumericSuffix("phone_field_3"), "phone_field");
  assert.equal(stripJunkNumericSuffix("item_list_2"), "item_list");
  assert.equal(stripJunkNumericSuffix("field_ก"), "field");
  assert.equal(stripJunkNumericSuffix("field_a"), "field");
  assert.equal(stripJunkNumericSuffix("ลำดับ"), "ลำดับ");
  assert.equal(looksLikeGarbledName("ab_ab_ab_cd"), true);
  assert.equal(looksLikeGarbledName("xx_xx_xx"), true);
  assert.equal(looksLikeGarbledName("เขต_อำเภอ"), false);
});

await check("preferContextualNameSource upgrades bare model names from labels", async () => {
  const { preferContextualNameSource } = await load();
  assert.equal(
    preferContextualNameSource("amount", "amount_total"),
    "amount_total",
  );
  assert.equal(
    preferContextualNameSource("items", "items_party"),
    "items_party",
  );
  assert.equal(
    preferContextualNameSource("zone_2", "zone / district"),
    "zone / district",
  );
});

await check("normalizeBoolArms defaults unchecked glyph", async () => {
  const {
    normalizeBoolArms,
    DEFAULT_BOOL_FALSE_TEXT,
    DEFAULT_BOOL_TRUE_TEXT,
  } = await load();
  const a = normalizeBoolArms("√", "");
  assert.equal(a.trueText, DEFAULT_BOOL_TRUE_TEXT);
  assert.equal(a.falseText, DEFAULT_BOOL_FALSE_TEXT);
  const b = normalizeBoolArms("☑", "☐");
  assert.equal(b.trueText, "☑");
  assert.equal(b.falseText, "☐");
});

await check("looksLikeRunSequence: data-driven column, not caption keywords", async () => {
  const { looksLikeRunSequence } = await load();
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
      cellIndex: 1,
      cellText: "1",
      isRunColumn: null,
    }),
    false,
    "Thai caption alone is not enough on non-first columns",
  );
  assert.equal(
    looksLikeRunSequence({
      header: "ราคา/หน่วย",
      cellIndex: 2,
      cellText: "1500",
      isRunColumn: false,
    }),
    false,
  );
  assert.equal(
    looksLikeRunSequence({
      header: "ราคา",
      cellIndex: 0,
      cellText: "100",
      isRunColumn: false,
    }),
    false,
    "col-0 price header must not count as run sequence",
  );
  assert.equal(
    looksLikeRunSequence({
      header: null,
      cellIndex: null,
      cellText: "หน้าสำรวจ",
    }),
    false,
  );
});

await check("validate: strips _2, demotes misused +, bool gets ☐", async () => {
  const { validateAiTagSuggestions, DEFAULT_BOOL_FALSE_TEXT } = await load();
  const plain =
    "ลำดับชื่อราคา/หน่วยหน้าสำรวจ1สมชาย1500หน้าหนึ่ง√บริษัทตัวอย่างจำกัด";
  const xml = readFileSync(join(fixturesDir, "name-quality-table.xml"), "utf8");

  const out = validateAiTagSuggestions(
    plain,
    [
      {
        plainText: "1สมชาย1500หน้าหนึ่ง",
        name: "item_rows_2",
        kind: "list-table",
        mode: "wrap-row",
      },
      { plainText: "1", name: "seq", kind: "auto", mode: "replace" },
      {
        plainText: "1500",
        name: "unit_price",
        kind: "auto",
        mode: "replace",
        label: "ราคา/หน่วย",
      },
      {
        plainText: "หน้าหนึ่ง",
        name: "+survey_page",
        kind: "auto",
        mode: "replace",
        label: "หน้าสำรวจ",
      },
      {
        plainText: "√",
        name: "flag_missing",
        kind: "bool",
        mode: "replace",
        trueText: "√",
        falseText: "",
      },
      {
        plainText: "บริษัทตัวอย่างจำกัด",
        name: "รายการ",
        kind: "text",
        mode: "replace",
        label: "รายการค่าใช้จ่าย",
      },
    ],
    xml,
    "th",
  );

  assert.ok(
    out.every((s) => !/_\d+$/.test(s.name)),
    `no junk numeric suffixes: ${out.map((s) => s.name).join(",")}`,
  );
  const price = out.find((s) => s.plainText === "1500" || s.headerHint === "ราคา/หน่วย");
  assert.ok(price, `price cell tagged; got ${out.map((s) => s.tag).join(" | ")}`);
  assert.notEqual(price.kind, "auto", "price must not be {{+}}");
  assert.ok(!String(price.tag).includes("{{+"), price.tag);

  const page = out.find((s) => s.plainText === "หน้าหนึ่ง");
  if (page) {
    assert.notEqual(page.kind, "auto");
    assert.ok(!String(page.tag).includes("{{+"));
  }

  // Digit flush to Thai often lands as fill-empty-tc; either way sequence stays auto/{{+}}.
  const seq = out.find(
    (s) =>
      (s.plainText === "1" && s.kind === "auto") ||
      (s.mode === "fill-empty-tc" &&
        s.cellIndex === 0 &&
        (s.kind === "auto" || String(s.tag || "").includes("+"))),
  );
  assert.ok(seq, `sequence digit tagged; got ${out.map((s) => s.tag).join(" | ")}`);

  const bool = out.find((s) => s.kind === "bool");
  assert.ok(bool, "bool suggestion present");
  assert.equal(bool.falseText, DEFAULT_BOOL_FALSE_TEXT);
  assert.match(bool.tag, new RegExp(`\\?√,${DEFAULT_BOOL_FALSE_TEXT}\\}\\}$`));

  const bare = out.find((s) => s.plainText === "บริษัทตัวอย่างจำกัด");
  assert.ok(bare, "labeled value tagged");
  assert.notEqual(bare.name, "รายการ", "bare name upgraded from label");
  assert.match(bare.name, /ค่าใช้จ่าย|รายการ/);
});

await check("validate: duplicate names disambiguate without _2", async () => {
  const { validateAiTagSuggestions } = await load();
  const plain = "เขตAเขตB";
  const out = validateAiTagSuggestions(
    plain,
    [
      { plainText: "เขตA", name: "เขต", kind: "text", label: "เขตผู้ซื้อ" },
      { plainText: "เขตB", name: "เขต", kind: "text", label: "เขตผู้ขาย" },
    ],
    null,
    "th",
  );
  assert.equal(out.length, 2);
  assert.notEqual(out[0].name, out[1].name);
  assert.ok(out.every((s) => !/_\d+$/.test(s.name)));
});

await check("splitPlainTextChunks respects soft boundaries", async () => {
  const { splitPlainTextChunks } = await load();
  const text = `${"ก".repeat(80)} ${"ข".repeat(80)}`;
  const chunks = splitPlainTextChunks(text, 90);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(""), text);
});


await check("normalizeBoolArms swaps inverted ☐,√", async () => {
  const { normalizeBoolArms } = await load();
  const a = normalizeBoolArms("☐", "√");
  assert.equal(a.trueText, "√");
  assert.equal(a.falseText, "☐");
  const b = normalizeBoolArms("☐", "✓");
  assert.equal(b.trueText, "✓");
  assert.equal(b.falseText, "☐");
});

await check("false checkbox fill uses unchecked glyph from AI tag", async () => {
  const { validateAiTagSuggestions, DEFAULT_BOOL_FALSE_TEXT } = await load();
  const { toFillValues } = await import(
    pathToFileURL(join(root, "src/server/source-map.ts")).href +
      `?t=${Date.now()}`
  );
  const out = validateAiTagSuggestions(
    "√",
    [
      {
        plainText: "√",
        name: "พบทรัพย์",
        kind: "bool",
        trueText: "√",
        falseText: "",
      },
    ],
    null,
    "th",
  );
  const sug = out.find((s) => s.kind === "bool");
  assert.ok(sug);
  assert.equal(sug.falseText, DEFAULT_BOOL_FALSE_TEXT);
  assert.match(sug.tag, /\?√,☐\}\}$/);
  const field = {
    name: sug.tag.replace(/^\{\{|\}\}$/g, ""),
    type: "bool",
    trueText: sug.trueText,
    falseText: sug.falseText,
    label: sug.name,
  };
  const vals = toFillValues([field], { [field.name]: false }, {}, {});
  assert.equal(vals[field.name], DEFAULT_BOOL_FALSE_TEXT);
});

if (failed) {
  console.error(`ai-tag-draft-name-quality-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("ai-tag-draft-name-quality-unit-test: ok");
