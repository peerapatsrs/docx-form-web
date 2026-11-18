#!/usr/bin/env node
/**
 * Fill-form validation: phantom +auto/totals, empty loops, jump targets, table labels.
 */
import assert from "node:assert/strict";
import {
  UI_LABELS,
  collectFormValidationMissing,
  collectMissingListValidation,
  formatExamplePlaceholder,
  listCellControlLabel,
  isAutoFieldName,
  shouldValidateRootField,
  fillableListItemFields,
} from "../public/ui-labels.js";
import {
  mergeMissingTextFields,
  normalizeFormFields,
} from "../public/doc-table-fields.js";

console.log("fill-form-validation-unit-test");

assert.equal(isAutoFieldName("+ลำดับจำเลย"), true);
assert.equal(isAutoFieldName("รวมทั้งสิ้น"), false);

{
  const fields = normalizeFormFields([
    { name: "ลูกค้า", type: "text" },
    { name: "+ลำดับจำเลย", type: "text" },
    { name: "รวมทั้งสิ้น", type: "text" },
    { name: "รวมทั้งสิ้น_ตัวอักษร", type: "text" },
    {
      name: "รายการ",
      type: "list",
      itemFields: [
        { name: "ชื่อ", type: "text" },
        { name: "+ที่", type: "auto", label: "ที่" },
      ],
    },
    {
      name: "ตารางว่าง",
      type: "list",
      itemFields: [{ name: "+เลข", type: "auto", label: "เลข" }],
    },
  ]);
  assert.equal(fields[1].type, "auto");
  const values = {
    ลูกค้า: "A",
    รวมทั้งสิ้น: "",
    รวมทั้งสิ้น_ตัวอักษร: "",
    รายการ: [{ ชื่อ: "x" }],
    ตารางว่าง: [{}],
  };
  const skip = {};
  const rendered = new Set(["ลูกค้า", "รายการ"]);
  const { missing, targets } = collectFormValidationMissing({
    fields,
    values,
    images: {},
    skip,
    rowSkip: {},
    labelMap: {},
    hasControl: (name) => rendered.has(name),
    hasListItemControl: (list, row, item) =>
      list === "รายการ" && item === "ชื่อ",
  });
  assert.ok(!missing.some((s) => s.includes("ลำดับ")), missing.join("|"));
  assert.ok(!missing.some((s) => s.includes("รวมทั้งสิ้น")), missing.join("|"));
  assert.ok(!missing.some((s) => s.includes("ตารางว่าง")), missing.join("|"));
  assert.equal(missing.length, 0, missing.join(", "));
  assert.equal(targets.length, 0);
  console.log("✓ auto-index, computed-like empties, empty-only loop not blocking");
}

{
  const { missing, targets } = collectFormValidationMissing({
    fields: [
      { name: "a", type: "text" },
      { name: "b", type: "text" },
    ],
    values: { a: "", b: "ok" },
    images: {},
    skip: {},
    rowSkip: {},
    labelMap: {},
  });
  assert.equal(missing.length, 1);
  assert.deepEqual(targets, [{ kind: "field", name: "a" }]);
  const second = collectFormValidationMissing({
    fields: [{ name: "a", type: "text" }, { name: "b", type: "text" }],
    values: { a: "x", b: "" },
    images: {},
    skip: {},
    rowSkip: {},
    labelMap: {},
  });
  assert.notEqual(second.targets[0]?.name, targets[0]?.name);
  console.log("✓ jump targets point at distinct fields");
}

{
  const itemField = { name: "เขตอำนาจศาล", type: "text", label: "เขตอำนาจศาล" };
  const label = listCellControlLabel(itemField, {
    สำนักงานที่ดินจังหวัด: "สำนักงานที่ดินจังหวัด",
  });
  const ph = formatExamplePlaceholder(label, itemField.name);
  assert.equal(label, "เขตอำนาจศาล");
  assert.equal(ph, "เช่น เขตอำนาจศาล");
  assert.ok(!ph.includes("สำนักงาน"));
  console.log("✓ table cell label/placeholder keyed by field id");
}

{
  const emptyLoop = collectMissingListValidation({
    fieldLabel: "ลูป",
    listName: "ลูป",
    itemFields: [{ name: "+ลำดับ", type: "auto", label: "ลำดับ" }],
    rows: [{}],
  });
  assert.deepEqual(emptyLoop.missing, []);
  assert.equal(
    shouldValidateRootField({
      name: "ลูป",
      type: "list",
      itemFields: [{ name: "+ลำดับ", type: "auto", label: "ลำดับ" }],
    }),
    false,
  );
  console.log("✓ list with only auto columns needs no row");
}

{
  const merged = mergeMissingTextFields([], ["+จำเลยที่", "ชื่อ"]);
  assert.equal(merged.added.length, 2);
  assert.equal(merged.fields.find((f) => f.name === "+จำเลยที่")?.type, "auto");
  console.log("✓ mergeMissingTextFields seeds +tags as auto");
}

console.log("fill-form-validation-unit-test: ok");