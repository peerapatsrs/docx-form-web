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
  isListRowEmpty,
  listHasFilledRow,
  collectMissingListValidation,
  countEmptyRequiredFields,
  clipValidationItems,
  formatInvalidEmailMissing,
  shouldShowSkipFirstUseTip,
  buildLayoutLabelMap,
  layoutBlocksToPlainText,
  listDisplayName,
} from "../public/ui-labels.js";

console.log("ui-labels-unit-test");

assert.equal(UI_LABELS.exportJson, "ส่งออก JSON");
assert.equal(UI_LABELS.importJson, "นำเข้า JSON");
assert.equal(UI_LABELS.toolsMenu, "เครื่องมือ");
assert.ok(UI_LABELS.homeHeadline.length > 0);
assert.equal(UI_LABELS.homeReadMore, "อ่านเพิ่ม");
assert.equal(UI_LABELS.homeAboutSummary, "เกี่ยวกับ docx-form");
assert.ok(UI_LABELS.dropzoneOrPick.includes("ฟรีสูงสุด 2"));
assert.equal(UI_LABELS.placeholderExamplePrefix, "เช่น ");
assert.equal(UI_LABELS.seededRowTip.includes("1 แถว"), true);
assert.equal(UI_LABELS.skip, "ข้าม");
assert.equal(UI_LABELS.draftListLoadFailed, "อ่านรายการดราฟไม่สำเร็จ");
assert.ok(
  UI_LABELS.loadDraftDialogBody.includes("IndexedDB") ||
    UI_LABELS.loadDraftDialogBody.includes("เบราว์เซอร์"),
);
assert.equal(UI_LABELS.dialogClose, "ปิด");
assert.equal(UI_LABELS.dialogCancel, "ยกเลิก");
assert.equal(UI_LABELS.dialogSave, "บันทึก");
assert.equal(UI_LABELS.dialogDelete, "ลบ");
assert.equal(UI_LABELS.dialogLoad, "โหลด");
assert.equal(UI_LABELS.draftFallbackTitle, "ดราฟ");
assert.equal(UI_LABELS.draftUntitled, "ไม่มีชื่อ");
assert.equal(UI_LABELS.draftSaveNoTemplate, "ยังไม่มีเทมเพลตให้บันทึกดราฟ");
assert.equal(UI_LABELS.draftSaveDialogTitle, "บันทึกดราฟ");
assert.ok(UI_LABELS.draftSaveDialogBody.includes("IndexedDB"));
assert.equal(UI_LABELS.draftSaveNameLabel, "ชื่อดราฟ (ไม่บังคับ)");
assert.equal(UI_LABELS.draftSaveSuccess("ใบเสนอราคา"), "บันทึกดราฟแล้ว: ใบเสนอราคา");
assert.equal(UI_LABELS.draftSaveFailed, "บันทึกดราฟไม่สำเร็จ");
assert.equal(UI_LABELS.draftMismatchTitle, "เทมเพลตต่างจากดราฟ");
assert.equal(UI_LABELS.draftMismatchUnknownFile, "ไม่ทราบไฟล์");
assert.equal(UI_LABELS.draftMismatchNoFile, "ยังไม่มีไฟล์");
assert.ok(
  UI_LABELS.draftMismatchBody("a.docx", "b.docx").includes("a.docx") &&
    UI_LABELS.draftMismatchBody("a.docx", "b.docx").includes("b.docx"),
);
assert.equal(UI_LABELS.draftMismatchConfirm, "โหลดแทนที่");
assert.equal(UI_LABELS.draftNotFound, "ไม่พบดราฟที่เลือก");
assert.equal(UI_LABELS.draftLoadIncomplete, "โหลดดราฟไม่สำเร็จ — ข้อมูลไม่ครบ");
assert.equal(UI_LABELS.draftLoadSuccess("ของฉัน"), "โหลดดราฟแล้ว: ของฉัน");
assert.equal(UI_LABELS.draftLoadFailed, "โหลดดราฟไม่สำเร็จ");
assert.ok(UI_LABELS.draftListEmpty.includes("ยังไม่มีดราฟ"));
assert.equal(UI_LABELS.draftDeleteTitle, "ลบดราฟนี้?");
assert.ok(UI_LABELS.draftDeleteBody.includes("กู้คืนไม่ได้"));
assert.equal(UI_LABELS.draftDeleteSuccess, "ลบดราฟแล้ว");
assert.equal(UI_LABELS.draftDeleteFailed, "ลบดราฟไม่สำเร็จ");
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

const itemFields7 = [
  { name: "name", type: "text" },
  { name: "qty", type: "text" },
  { name: "price", type: "text" },
  { name: "unit", type: "text" },
  { name: "note", type: "text" },
  { name: "sku", type: "text" },
  { name: "desc", type: "text" },
];
assert.equal(isListRowEmpty({}, itemFields7), true);
assert.equal(isListRowEmpty({ name: "", qty: "  " }, itemFields7), true);
assert.equal(isListRowEmpty({ name: "A" }, itemFields7), false);
assert.equal(listHasFilledRow([{}], itemFields7), false);
assert.equal(listHasFilledRow(seedListRowsIfEmpty([]), itemFields7), false);
assert.equal(listHasFilledRow([{ name: "A" }, {}], itemFields7), true);

const emptySeeded = collectMissingListValidation({
  fieldLabel: "รายการสินค้า",
  itemFields: itemFields7,
  rows: seedListRowsIfEmpty([]),
});
assert.equal(emptySeeded.mode, "need-row");
assert.deepEqual(emptySeeded.missing, [
  formatMissingFieldLabel("รายการสินค้า", UI_LABELS.validationListNeedFilledRow),
]);
assert.equal(emptySeeded.missing.length, 1);

const partial = collectMissingListValidation({
  fieldLabel: "รายการสินค้า",
  itemFields: itemFields7,
  rows: [{ name: "A", qty: "", price: "", unit: "", note: "", sku: "", desc: "" }, {}],
  labelMap: { name: "สินค้า", qty: "จำนวน" },
});
assert.equal(partial.mode, "cells");
assert.ok(partial.missing.every((s) => !s.includes("แถว 2.")));
assert.ok(partial.missing.some((s) => s.includes("แถว 1.")));
assert.ok(!partial.missing.includes(
  formatMissingFieldLabel("รายการสินค้า", UI_LABELS.validationListNeedFilledRow),
));
console.log("✓ empty table row counts as one need-row item");

assert.deepEqual(
  clipValidationItems(Array.from({ length: 14 }, (_, i) => `f${i}`)),
  [
    ...Array.from({ length: 12 }, (_, i) => `f${i}`),
    UI_LABELS.validationAndMoreFields(2),
  ],
);
assert.equal(formatInvalidEmailMissing("อีเมล"), `อีเมล ${UI_LABELS.invalidEmailSuffix}`);
console.log("✓ clipValidationItems + invalid email label");

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

const listSkipped = collectMissingListValidation({
  fieldLabel: "รายการ",
  itemFields: [{ name: "name", type: "text" }],
  rows: [{}],
  listSkipped: true,
});
assert.equal(listSkipped.missing.length, 0);

const emptyCount = countEmptyRequiredFields({
  fields: [
    { name: "a", type: "text" },
    { name: "b", type: "text" },
  ],
  values: { a: "ok", b: "" },
  skip: { b: true },
});
assert.equal(emptyCount, 0);
console.log("✓ list skip + empty count");

assert.equal(UI_LABELS.createTemplate, UI_LABELS.createTemplateFromDoc);
console.log("✓ create template wording");

console.log("\nAll ui-labels unit tests passed");
