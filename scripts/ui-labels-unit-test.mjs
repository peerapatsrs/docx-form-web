#!/usr/bin/env node
/**
 * Unit tests for central Thai UI labels / display helpers.
 */
import assert from "node:assert/strict";
import {
  UI_LABELS,
  fieldDisplayLabel,
  formatExamplePlaceholder,
  formatMissingFieldLabel,
  formatValidationBannerModel,
  seedListRowsIfEmpty,
  shouldShowSkipFirstUseTip,
  buildLayoutLabelMap,
  layoutBlocksToPlainText,
  listDisplayName,
} from "../public/ui-labels.js";

console.log("ui-labels-unit-test");

assert.equal(UI_LABELS.exportJson, "ส่งออก JSON");
assert.equal(UI_LABELS.importJson, "นำเข้า JSON");
assert.equal(UI_LABELS.toolsMenu, "เครื่องมือ");
assert.equal(UI_LABELS.placeholderExamplePrefix, "เช่น ");
assert.equal(UI_LABELS.seededRowTip.includes("1 แถว"), true);
assert.equal(UI_LABELS.skip, "ข้าม");
console.log("✓ UI_LABELS core strings");

assert.equal(
  fieldDisplayLabel({ name: "customer_name", label: "ลูกค้า" }, null),
  "ลูกค้า",
);
assert.equal(
  fieldDisplayLabel({ name: "customer_name" }, { customer_name: "ลูกค้า" }),
  "ลูกค้า",
);
assert.equal(
  fieldDisplayLabel({ name: "customer_name" }, new Map([["customer_name", "ลูกค้า"]])),
  "ลูกค้า",
);
assert.equal(fieldDisplayLabel({ name: "note" }, null), "note");
assert.equal(
  fieldDisplayLabel(
    { name: "x", aliases: ["customer_name"] },
    { customer_name: "ลูกค้า" },
  ),
  "ลูกค้า",
);
console.log("✓ fieldDisplayLabel");

assert.equal(formatExamplePlaceholder("ลูกค้า"), "เช่น ลูกค้า");
assert.equal(formatExamplePlaceholder(""), "");
assert.equal(
  formatMissingFieldLabel("รายการสินค้า", UI_LABELS.validationListMinRows),
  "รายการสินค้า (ต้องมีอย่างน้อย 1 แถว)",
);
console.log("✓ placeholder + missing label");

const banner = formatValidationBannerModel(["ลูกค้า", "วันที่", "โลโก้"]);
assert.equal(banner.title, "ยังมีช่องที่ยังไม่ได้กรอก (3)");
assert.deepEqual(banner.items, ["ลูกค้า", "วันที่", "โลโก้"]);
assert.equal(banner.hint, UI_LABELS.validationHint);
console.log("✓ validation banner model");

assert.deepEqual(seedListRowsIfEmpty(undefined), [{}]);
assert.deepEqual(seedListRowsIfEmpty(null), [{}]);
assert.deepEqual(seedListRowsIfEmpty([]), [{}]);
const kept = [{ a: "1" }, { a: "2" }];
assert.equal(seedListRowsIfEmpty(kept), kept);
console.log("✓ seedListRowsIfEmpty");

assert.equal(shouldShowSkipFirstUseTip(null), true);
assert.equal(shouldShowSkipFirstUseTip(""), true);
assert.equal(shouldShowSkipFirstUseTip("1"), false);
assert.equal(shouldShowSkipFirstUseTip("true"), false);
console.log("✓ skip first-use tip flag");

const samplePlain = `ใบเสนอราคาตัวอย่าง
ลูกค้า: {{customer_name}}
วันที่: {{date}}
โลโก้:
{{logo}}
รายการสินค้า
สินค้า\tจำนวน\tราคา
{{name}}\t{{qty}}\t{{price}}
{{#items}}
หมายเหตุ: {{note}}`;

const map = buildLayoutLabelMap(samplePlain, [
  { name: "items", type: "list" },
  { name: "logo", type: "image" },
]);
assert.equal(map.get("customer_name"), "ลูกค้า");
assert.equal(map.get("date"), "วันที่");
assert.equal(map.get("note"), "หมายเหตุ");
assert.equal(map.get("items"), "รายการสินค้า");
assert.equal(map.get("logo"), "โลโก้");
assert.equal(map.get("name"), "สินค้า");
assert.equal(map.get("qty"), "จำนวน");
assert.equal(map.get("price"), "ราคา");
assert.equal(listDisplayName("items", { name: "items" }, map), "รายการสินค้า");
console.log("✓ buildLayoutLabelMap + listDisplayName");

const plainFromBlocks = layoutBlocksToPlainText(
  [
    { type: "text", text: "ลูกค้า: {{customer_name}}" },
    { type: "image", fieldName: "logo", label: "โลโก้" },
    {
      type: "table",
      listName: "items",
      headerRows: [[{ text: "สินค้า" }, { text: "จำนวน" }]],
      templateCells: [{ text: "{{name}}" }, { text: "{{qty}}" }],
    },
  ],
  "",
);
assert.match(plainFromBlocks, /customer_name/);
assert.match(plainFromBlocks, /\{\{logo\}\}/);
assert.match(plainFromBlocks, /\{\{#items\}\}/);
console.log("✓ layoutBlocksToPlainText");

console.log("\nAll ui-labels unit tests passed");
