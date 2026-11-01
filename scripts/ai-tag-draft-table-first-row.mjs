#!/usr/bin/env node
/**
 * Smoke: AI tag draft accepts list-table / wrap-row / fill-empty-tc / cell fields
 * on the FIRST data (prototype) row only; later sample rows and header stay out.
 * Run: npx tsx scripts/ai-tag-draft-table-first-row.mjs
 */
import assert from "node:assert/strict";
import { validateAiTagSuggestions } from "../src/server/ai-tag-draft.ts";

const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>นอกตารางชื่อสมชาย</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>ลำดับ</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>ชื่อ</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>เขต / อำเภอ</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>ในตารางสมชาย</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t></w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>แถวสองไม่ควรแท็ก</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t></w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

const plain = "นอกตารางชื่อสมชายลำดับชื่อเขต / อำเภอ1ในตารางสมชาย2แถวสองไม่ควรแท็ก";

const outTh = validateAiTagSuggestions(
  plain,
  [
    { plainText: "นอกตารางชื่อสมชาย", name: "ชื่อนอก", kind: "text", mode: "replace" },
    {
      plainText: "ในตารางสมชาย",
      name: "รายการจำเลย",
      kind: "list-table",
      mode: "wrap-row",
    },
    { plainText: "1", name: "ลำดับ", kind: "auto", mode: "replace" },
    { plainText: "ในตารางสมชาย", name: "ชื่อ", kind: "text", mode: "replace" },
    {
      plainText: "ในตารางสมชาย",
      name: "เขต_อำเภอ",
      kind: "text",
      mode: "fill-empty-tc",
      cellIndex: 2,
    },
    // Later sample row — must be rejected.
    {
      plainText: "แถวสองไม่ควรแท็ก",
      name: "รายการแถวสอง",
      kind: "list-table",
      mode: "wrap-row",
    },
    { plainText: "2", name: "ลำดับ2", kind: "auto", mode: "replace" },
    { plainText: "แถวสองไม่ควรแท็ก", name: "ชื่อ2", kind: "text", mode: "replace" },
  ],
  xml,
  "th",
);

assert.ok(
  outTh.some((s) => s.plainText === "นอกตารางชื่อสมชาย" && s.kind === "text"),
  "outside-table text should remain",
);

const wrap = outTh.find((s) => s.kind === "list-table" || s.mode === "wrap-row");
assert.ok(wrap, "prototype list-table / wrap-row must be kept");
assert.equal(wrap.mode, "wrap-row");
assert.ok(
  typeof wrap.rowPlainStart === "number" &&
    typeof wrap.rowPlainEnd === "number" &&
    wrap.rowPlainEnd > wrap.rowPlainStart,
  "wrap-row should expose row plain span",
);

// First column "1" sits flush against Thai cell text in TAGGER_PLAIN ("1ใน…"),
// so plain replace of "1" is rejected; enrich falls back to fill-empty-tc on cell 0
// (same as manual list-table) while still emitting {{+ลำดับ}} as the value field.
assert.ok(
  outTh.some(
    (s) =>
      (s.plainText === "1" && (s.kind === "auto" || s.mode === "replace")) ||
      (s.mode === "fill-empty-tc" &&
        s.cellIndex === 0 &&
        (s.kind === "auto" || String(s.tag || "").includes("+"))),
  ),
  "first cell must get a value field (auto/replace or fill-empty-tc), not only the list marker",
);

assert.ok(
  outTh.some((s) => s.plainText === "ในตารางสมชาย" && s.kind === "text" && s.mode === "replace"),
  "prototype non-empty cell should be tagged",
);

assert.ok(
  outTh.some((s) => s.mode === "fill-empty-tc" && s.cellIndex === 2),
  "empty prototype cell under header must become fill-empty-tc",
);

assert.ok(
  !outTh.some((s) => s.plainText === "แถวสองไม่ควรแท็ก"),
  "later sample-row text must be rejected",
);
assert.ok(
  !outTh.some((s) => s.plainText === "2" && s.kind === "auto"),
  "later sample-row digit must be rejected",
);
assert.equal(
  outTh.filter((s) => s.kind === "list-table" || s.mode === "wrap-row").length,
  1,
  "only one wrap-row per table (prototype)",
);

const outEn = validateAiTagSuggestions(
  plain,
  [
    {
      plainText: "ในตารางสมชาย",
      name: "defendant_rows",
      kind: "list-table",
      mode: "wrap-row",
    },
  ],
  xml,
  "en",
);

assert.ok(
  outEn.some((s) => s.kind === "list-table" && s.mode === "wrap-row"),
  "EN: wrap-row accepted",
);
// Enrichment should invent English-ish cell names from Thai headers.
const enAuto = outEn.find((s) => s.kind === "auto" || (s.plainText === "1" && s.mode === "replace"));
assert.ok(enAuto, "EN: first-cell field enriched");
assert.ok(
  /^[a-z0-9_.-]+$/i.test(enAuto.name),
  `EN: first-cell name should be ASCII snake_case, got ${enAuto.name}`,
);
const enEmpty = outEn.find((s) => s.mode === "fill-empty-tc" && s.cellIndex === 2);
assert.ok(enEmpty, "EN: empty cell enriched");
assert.ok(
  /^[a-z0-9_.-]+$/i.test(enEmpty.name),
  `EN: empty-cell name should be ASCII snake_case, got ${enEmpty.name}`,
);

console.log(
  `✓ ai-tag-draft first-row table smoke (th=${outTh.length}, en=${outEn.length})`,
);

// Multi-row Thai headers (long merged titles, no w:tblHeader) — like จำเลยที่ forms.
// Row 0/1 are headers; row 2 with "1" is the prototype. Model may omit wrap-row.
const multiHeaderXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>จำลยที่</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>สืบตามเขตอำนาจศาล / ภูมิลำเนา ณวันฟ้องคดี</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>สืบตามภูมิลำเนาปัจจุบัน / อื่นๆ</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>ผลสืบ</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t></w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>เขต / อำเภอ</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>สำนักงานที่ดินจังหวัด</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>พบ</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>เมืองปทุมธานี</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>ปทุมธานี</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>√</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>เมืองปทุมธานี</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>ปทุมธานี</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>√</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

const multiPlain =
  "จำลยที่สืบตามเขตอำนาจศาล / ภูมิลำเนา ณวันฟ้องคดีสืบตามภูมิลำเนาปัจจุบัน / อื่นๆผลสืบเขต / อำเภอสำนักงานที่ดินจังหวัดพบ1เมืองปทุมธานีปทุมธานี√2เมืองปทุมธานีปทุมธานี√";

// No model wrap — seeds + enrichment must still propose list-table + first cell.
const outSeed = validateAiTagSuggestions(
  multiPlain,
  [
    // Model only tags standalone digit; must not block seeded wrap / enrichment.
    { plainText: "1", name: "ที่", kind: "auto", mode: "replace" },
  ],
  multiHeaderXml,
  "th",
);

const seedWrap = outSeed.find((s) => s.kind === "list-table" || s.mode === "wrap-row");
assert.ok(seedWrap, "multi-header: seeded list-table wrap must appear");
assert.equal(seedWrap.mode, "wrap-row");
assert.ok(
  /จำเล|รายการ/.test(seedWrap.name),
  `multi-header: list name should reflect จำเลย, got ${seedWrap.name}`,
);
assert.ok(
  outSeed.some(
    (s) =>
      (s.plainText === "1" && (s.kind === "auto" || s.mode === "replace")) ||
      (s.mode === "fill-empty-tc" &&
        s.cellIndex === 0 &&
        (s.kind === "auto" || String(s.tag || "").includes("+"))),
  ),
  "multi-header: first data cell must get a value field",
);
assert.ok(
  !outSeed.some((s) => s.kind === "list-table" && /สืบตามเขต/.test(s.plainText || "")),
  "multi-header: must not wrap the long header row",
);
assert.equal(
  outSeed.filter((s) => s.kind === "list-table" || s.mode === "wrap-row").length,
  1,
  "multi-header: only one wrap-row (prototype data row)",
);

console.log(
  `✓ ai-tag-draft multi-header prototype smoke (seeded=${outSeed.length})`,
);

// Stray auto outside any list / list-table must become plain text {{name}}, not {{+name}}.
const strayPlain = "จำเลยที่ 1 เป็นคู่ความนอกตาราง";
const outStray = validateAiTagSuggestions(
  strayPlain,
  [
    { plainText: "จำเลยที่", name: "จำเลยที่", kind: "auto", mode: "replace" },
    { plainText: "1", name: "ลำดับ", kind: "auto", mode: "replace" },
  ],
  null,
  "th",
);
assert.ok(
  outStray.every((s) => s.kind !== "auto" && !String(s.tag || "").includes("{{+")),
  "stray auto outside lists must demote to text (no {{+}})",
);
assert.ok(
  outStray.some((s) => s.plainText === "จำเลยที่" && s.kind === "text" && s.tag === "{{จำเลยที่}}"),
  "header-like label tagged auto must become {{จำเลยที่}}",
);
assert.ok(
  outStray.some((s) => s.plainText === "1" && s.kind === "text" && s.tag === "{{ลำดับ}}"),
  "digit outside loop tagged auto must become plain text {{ลำดับ}}",
);
console.log(`✓ ai-tag-draft stray-auto demote smoke (n=${outStray.length})`);

// Paragraph list: consecutive 「จำเลยที่ N」outside tables → wrap FIRST unit only;
// later units hard-blocked; auto inside wrap kept; stray fields on unit 2 dropped.
const paraXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>หนังสือฟ้อง</w:t></w:r></w:p>
    <w:p><w:r><w:t>จำเลยที่ 1 ชื่อ นายหนึ่ง ที่อยู่ บ้านหนึ่ง</w:t></w:r></w:p>
    <w:p><w:r><w:t>จำเลยที่ 2 ชื่อ นายสอง ที่อยู่ บ้านสอง</w:t></w:r></w:p>
    <w:p><w:r><w:t>จำเลยที่ 3 ชื่อ นายสาม ที่อยู่ บ้านสาม</w:t></w:r></w:p>
    <w:p><w:r><w:t>จึงเรียนมาเพื่อโปรดพิจารณา</w:t></w:r></w:p>
  </w:body>
</w:document>`;
const paraPlain =
  "หนังสือฟ้องจำเลยที่ 1 ชื่อ นายหนึ่ง ที่อยู่ บ้านหนึ่งจำเลยที่ 2 ชื่อ นายสอง ที่อยู่ บ้านสองจำเลยที่ 3 ชื่อ นายสาม ที่อยู่ บ้านสามจึงเรียนมาเพื่อโปรดพิจารณา";

const outPara = validateAiTagSuggestions(
  paraPlain,
  [
    // Model wrongly tags each defendant as a separate scalar — must not beat the list.
    {
      plainText: "จำเลยที่ 1 ชื่อ นายหนึ่ง ที่อยู่ บ้านหนึ่ง",
      name: "จำเลย1",
      kind: "text",
      mode: "replace",
    },
    {
      plainText: "จำเลยที่ 2 ชื่อ นายสอง ที่อยู่ บ้านสอง",
      name: "จำเลย2",
      kind: "text",
      mode: "replace",
    },
    {
      plainText: "จำเลยที่ 3 ชื่อ นายสาม ที่อยู่ บ้านสาม",
      name: "จำเลย3",
      kind: "text",
      mode: "replace",
    },
    // Inner field inside first unit + auto runno.
    { plainText: "นายหนึ่ง", name: "ชื่อ", kind: "text", mode: "replace" },
    { plainText: "1", name: "ลำดับ", kind: "auto", mode: "replace" },
    // Over-wide wrap covering all three — must clamp to first unit.
    {
      plainText:
        "จำเลยที่ 1 ชื่อ นายหนึ่ง ที่อยู่ บ้านหนึ่งจำเลยที่ 2 ชื่อ นายสอง ที่อยู่ บ้านสองจำเลยที่ 3 ชื่อ นายสาม ที่อยู่ บ้านสาม",
      name: "รายการทั้งหมด",
      kind: "list",
      mode: "wrap",
    },
  ],
  paraXml,
  "th",
);

const paraWrap = outPara.find((s) => s.kind === "list" && s.mode === "wrap");
assert.ok(paraWrap, "paragraph list wrap must be seeded/accepted");
assert.equal(
  paraWrap.plainText,
  "จำเลยที่ 1 ชื่อ นายหนึ่ง ที่อยู่ บ้านหนึ่ง",
  "wrap must be FIRST defendant unit only",
);
assert.equal(paraWrap.tag, "{{#รายการจำเลย}}");
assert.ok(
  outPara.some(
    (s) => s.plainText === "นายหนึ่ง" && s.kind === "text" && s.wrapTag === paraWrap.tag,
  ),
  "inner text field inside first unit must nest under the list wrap",
);
assert.ok(
  outPara.some(
    (s) =>
      s.plainText === "1" &&
      s.kind === "auto" &&
      String(s.tag || "").includes("{{+") &&
      s.wrapTag === paraWrap.tag,
  ),
  "digit inside paragraph list wrap must stay auto {{+}}",
);
assert.ok(
  !outPara.some((s) => /นายสอง|นายสาม|จำเลย2|จำเลย3/.test(s.plainText || "")),
  "later defendant units must not get their own field tags",
);
assert.equal(
  outPara.filter((s) => s.kind === "list").length,
  1,
  "only one paragraph-list wrap per stem group",
);
console.log(`✓ ai-tag-draft paragraph-list first-unit smoke (n=${outPara.length})`);

// Real Word docs often put <w:tab/> between 「จำเลยที่」and the digit — plain must
// keep \\t or seeded list wraps never match TAGGER_PLAIN.
const paraTabXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>จำเลยที่</w:t><w:tab/><w:t>1</w:t><w:tab/><w:t>ชื่อ นายหนึ่ง</w:t></w:r></w:p>
    <w:p><w:r><w:t>จำเลยที่</w:t><w:tab/><w:t>2</w:t><w:tab/><w:t>ชื่อ นายสอง</w:t></w:r></w:p>
    <w:p><w:r><w:t>จำเลยที่</w:t><w:tab/><w:t>3</w:t><w:tab/><w:t>ชื่อ นายสาม</w:t></w:r></w:p>
  </w:body>
</w:document>`;
const paraTabPlain =
  "จำเลยที่\t1\tชื่อ นายหนึ่งจำเลยที่\t2\tชื่อ นายสองจำเลยที่\t3\tชื่อ นายสาม";
const outParaTab = validateAiTagSuggestions(
  paraTabPlain,
  [
    { plainText: "1", name: "จำเลยที่", kind: "text", mode: "replace" },
    { plainText: "นายสอง", name: "ชื่อ2", kind: "text", mode: "replace" },
  ],
  paraTabXml,
  "th",
);
const paraTabWrap = outParaTab.find((s) => s.kind === "list" && s.mode === "wrap");
assert.ok(paraTabWrap, "tabbed paragraph list wrap must be seeded");
assert.equal(
  paraTabWrap.plainText,
  "จำเลยที่\t1\tชื่อ นายหนึ่ง",
  "tabbed wrap plain must retain w:tab as \\\\t",
);
assert.ok(
  !outParaTab.some((s) => s.plainText === "นายสอง"),
  "later tabbed defendant unit must stay untagged",
);
console.log(`✓ ai-tag-draft paragraph-list tabbed-unit smoke (n=${outParaTab.length})`);

// Label-anchored + flexible tabs: AI returns value + label; doc has Label\\t\\tValue.
const labelPlain =
  "บริษัท ทดสอบ จำกัดประเภทหนี้\t\tกู้ยืม\t\tทะเบียนลูกหนี้\t62014610\tศาล\tธัญบุรี";
const outLabel = validateAiTagSuggestions(
  labelPlain,
  [
    {
      plainText: "กู้ยืม",
      label: "ประเภทหนี้",
      name: "ประเภทหนี้",
      kind: "text",
      mode: "replace",
    },
    {
      // Wrong separator in plainText — must still resolve via label or flexible match.
      plainText: "ประเภทหนี้ กู้ยืม",
      label: "ประเภทหนี้",
      name: "ประเภทหนี้ซ้ำ",
      kind: "text",
      mode: "replace",
    },
    {
      plainText: "62014610",
      label: "ทะเบียนลูกหนี้",
      name: "ทะเบียนลูกหนี้",
      kind: "text",
      mode: "replace",
    },
  ],
  null,
  "th",
);
const loan = outLabel.find((s) => s.plainText === "กู้ยืม");
assert.ok(loan, "label-anchored กู้ยืม must match despite \\\\t\\\\t in doc");
assert.equal(loan.labelHint, "ประเภทหนี้");
assert.ok(
  outLabel.some((s) => s.plainText === "62014610" && s.labelHint === "ทะเบียนลูกหนี้"),
  "ทะเบียนลูกหนี้ value must label-anchor",
);
// Second suggestion also collapses to the same value span — first wins; duplicate name skipped or second dropped.
assert.ok(
  !outLabel.some((s) => s.plainText.includes("ประเภทหนี้") && s.plainText.includes("กู้ยืม")),
  "must tag value only, not label+value blob",
);
console.log(`✓ ai-tag-draft label-anchored tab smoke (n=${outLabel.length})`);

// Space-separated prose (no \\t): มอบหมายให้ บริษัท… (ตัวอย่าง)
const assignPlain =
  "ตามหนังสือมอบอำนาจ มอบหมายให้ บริษัท กฎหมาย บีไอจี จำกัด (ตัวอย่าง) เป็นผู้รับมอบ";
const outAssign = validateAiTagSuggestions(
  assignPlain,
  [
    {
      plainText: "บริษัท กฎหมาย บีไอจี จำกัด",
      label: "มอบหมายให้",
      name: "ผู้รับมอบหมาย",
      kind: "text",
      mode: "replace",
    },
    {
      // AI included sample marker — still resolve to the company name (or full if exact).
      plainText: "บริษัท กฎหมาย บีไอจี จำกัด (ตัวอย่าง)",
      label: "มอบหมายให้",
      name: "ผู้รับมอบหมาย2",
      kind: "text",
      mode: "replace",
    },
    {
      // AI glued label+value with a space — must shrink to value.
      plainText: "มอบหมายให้ บริษัท กฎหมาย บีไอจี จำกัด",
      label: "มอบหมายให้",
      name: "ผู้รับมอบหมาย3",
      kind: "text",
      mode: "replace",
    },
  ],
  null,
  "th",
);
const company = outAssign.find((s) =>
  String(s.plainText || "").includes("บีไอจี"),
);
assert.ok(company, "space-separated มอบหมายให้ → บริษัท… must match");
assert.equal(company.labelHint, "มอบหมายให้");
assert.ok(
  !String(company.plainText).startsWith("มอบหมายให้"),
  "must tag company value only, not the stem มอบหมายให้",
);
console.log(`✓ ai-tag-draft label-anchored space smoke (n=${outAssign.length})`);

// Flush / glued (no space): (โทร02-023-2599) and multi (โทร02-…,02-…)
const phonePlain =
  "ติดต่อสำนักงานใหญ่(โทร02-023-2599) สำนักงานสาขา(โทร02-023-2599,02-023-2591) ตัวอย่าง";
const outPhone = validateAiTagSuggestions(
  phonePlain,
  [
    {
      plainText: "02-023-2599",
      label: "โทร",
      name: "โทรศัพท์",
      kind: "text",
      mode: "replace",
      occurrence: 0,
    },
    {
      plainText: "02-023-2599,02-023-2591",
      label: "โทร",
      name: "โทรศัพท์สาขา",
      kind: "text",
      mode: "replace",
    },
    {
      // AI forgot label and glued stem into plainText — still resolve to digits.
      plainText: "โทร02-023-2599",
      name: "โทรศัพท์3",
      kind: "text",
      mode: "replace",
      occurrence: 0,
    },
  ],
  null,
  "th",
);
const phone1 = outPhone.find(
  (s) => s.plainText === "02-023-2599" && s.labelHint === "โทร",
);
assert.ok(phone1, "flush โทร02-023-2599 must label-anchor to digits");
assert.ok(
  outPhone.some(
    (s) =>
      s.plainText === "02-023-2599,02-023-2591" && s.labelHint === "โทร",
  ),
  "flush multi-phone list after โทร must match",
);
assert.ok(
  outPhone.some((s) => s.plainText === "02-023-2599"),
  "glued plainText โทร02-… without label must still find digits",
);
console.log(`✓ ai-tag-draft label-anchored flush-phone smoke (n=${outPhone.length})`);

// Flush text (not only digits): มอบหมายให้บริษัท… and โทรสำนักงานใหญ่
const flushTextPlain =
  "มอบหมายให้บริษัท กฎหมาย บีไอจี จำกัดเป็นผู้รับมอบ (โทรสำนักงานใหญ่) ปิดท้าย";
const outFlushText = validateAiTagSuggestions(
  flushTextPlain,
  [
    {
      plainText: "บริษัท กฎหมาย บีไอจี จำกัด",
      label: "มอบหมายให้",
      name: "ผู้รับมอบหมาย",
      kind: "text",
      mode: "replace",
    },
    {
      plainText: "สำนักงานใหญ่",
      label: "โทร",
      name: "โทรถึง",
      kind: "text",
      mode: "replace",
    },
    {
      // AI glued stem+text without label — still peel to text body.
      plainText: "โทรสำนักงานใหญ่",
      name: "โทรถึง2",
      kind: "text",
      mode: "replace",
    },
  ],
  null,
  "th",
);
const flushCo = outFlushText.find((s) =>
  String(s.plainText || "").includes("บีไอจี"),
);
assert.ok(flushCo, "flush text after มอบหมายให้ must match company name");
assert.equal(flushCo.labelHint, "มอบหมายให้");
assert.ok(
  outFlushText.some(
    (s) => s.plainText === "สำนักงานใหญ่" && s.labelHint === "โทร",
  ),
  "flush text after โทร (not digits) must match",
);
assert.ok(
  outFlushText.some((s) => s.plainText === "สำนักงานใหญ่"),
  "glued โทรสำนักงานใหญ่ without label must peel to text",
);
assert.ok(
  !outFlushText.some((s) => String(s.plainText).startsWith("โทรสำนักงาน")),
  "must not keep โทร glued into the tagged plainText",
);
console.log(`✓ ai-tag-draft label-anchored flush-text smoke (n=${outFlushText.length})`);

// One AI row → every safe occurrence (not only the first match).
const multiOccPlain =
  "ชื่อสมชายใจดี ที่อยู่กรุงเทพฯ ชื่อสมชายใจดี เบอร์02-111 และชื่อสมชายใจดีอีกครั้ง";
const outMultiOcc = validateAiTagSuggestions(
  multiOccPlain,
  [
    {
      plainText: "สมชายใจดี",
      label: "ชื่อ",
      name: "ชื่อ",
      kind: "text",
      mode: "replace",
      occurrence: 0,
    },
  ],
  null,
  "th",
);
const nameHits = outMultiOcc.filter(
  (s) => s.plainText === "สมชายใจดี" && s.name === "ชื่อ",
);
assert.equal(nameHits.length, 3, "one AI suggestion must expand to all 3 name hits");
assert.ok(
  new Set(nameHits.map((s) => s.plainStart)).size === 3,
  "expanded hits must be distinct plainStart offsets",
);
console.log(`✓ ai-tag-draft multi-occurrence expand smoke (n=${outMultiOcc.length})`);

// Short digit must NOT shard a phone number (ของจำเลยที่ → plain "3" inside 02-023-2599).
const phoneShardPlain =
  "เบอร์โทรศัพท์ 02-023-2599,096-392-3961 ของจำเลยที่ 3 และจำเลยที่ 3 อีก";
const outPhoneShard = validateAiTagSuggestions(
  phoneShardPlain,
  [
    {
      plainText: "3",
      label: "ของจำเลยที่",
      name: "ของจำเลยที่",
      kind: "text",
      mode: "replace",
      occurrence: 0,
    },
  ],
  null,
  "th",
);
assert.ok(
  !outPhoneShard.some((s) => {
    const at = Number(s.plainStart);
    return (
      s.plainText === "3" &&
      Number.isFinite(at) &&
      phoneShardPlain.slice(Math.max(0, at - 4), at + 5).includes("02-02")
    );
  }),
  "digit 3 must not tag inside 02-023-2599",
);
const threes = outPhoneShard.filter((s) => s.plainText === "3");
assert.ok(threes.length >= 1, "standalone จำเลยที่ 3 digits should still match");
assert.ok(
  threes.every((s) => {
    const at = Number(s.plainStart);
    const prev = at > 0 ? phoneShardPlain[at - 1] : "";
    return !/[\d-]/.test(prev || "");
  }),
  "matched 3s must be token-bounded, not mid-phone",
);
console.log(`✓ ai-tag-draft phone-shard digit smoke (n=${outPhoneShard.length})`);

// Longer digit cells flush to Thai (Word tables omit separators) must still match.
const digitFlushPlain =
  "1โฉนด/นส.3ก58407464        4578ปทุมธานีเมืองปทุมธานี ค่าจ้าง1200หนึ่งพันสองร้อยบาท";
const outDigitFlush = validateAiTagSuggestions(
  digitFlushPlain,
  [
    {
      plainText: "1",
      label: "ที่",
      name: "ที่_แถว",
      kind: "text",
      mode: "replace",
    },
    {
      plainText: "4578",
      label: "หน้าสำรวจ",
      name: "หน้าสำรวจ",
      kind: "text",
      mode: "replace",
    },
    {
      plainText: "1200",
      label: "ราคา/หน่วย",
      name: "ราคาต่อหน่วย",
      kind: "text",
      mode: "replace",
    },
  ],
  null,
  "th",
);
assert.ok(
  !outDigitFlush.some((s) => s.plainText === "1" && digitFlushPlain[s.plainStart + 1] === "โ"),
  "single-digit row marker flush to Thai must not tag",
);
assert.ok(
  outDigitFlush.some((s) => s.plainText === "4578"),
  "4-digit page-survey flush to Thai must tag",
);
assert.ok(
  outDigitFlush.some((s) => s.plainText === "1200"),
  "price digits flush to Thai words must tag",
);
console.log(`✓ ai-tag-draft digit-flush-thai smoke (n=${outDigitFlush.length})`);

// Unique footer/total cells in a later table row must tag; duplicate sample values must not.
{
  const footerPlain =
    "หัวคอลัมน์\n1ค่าจ้าง1200บาท\nภาษี\nรวมทั้งสิ้น           1,116หนึ่งพันหนึ่งร้อยสิบหกบาท";
  // Minimal fake XML: two body rows in one table; prototype = first data row with 1200.
  const footerXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>หัวคอลัมน์</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>1ค่าจ้าง1200บาท</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>ภาษี</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>รวมทั้งสิ้น           1,116หนึ่งพันหนึ่งร้อยสิบหกบาท</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl></w:body></w:document>`;
  const outFooter = validateAiTagSuggestions(
    footerPlain,
    [
      {
        plainText: "1ค่าจ้าง1200บาท",
        name: "รายการค่าใช้จ่าย",
        kind: "list-table",
        mode: "wrap-row",
      },
      {
        plainText: "1200",
        label: "ราคา",
        name: "ราคา_แถว2",
        kind: "text",
        mode: "replace",
        occurrence: 0,
      },
      {
        plainText: "1,116",
        label: "รวมทั้งสิ้น",
        name: "รวมทั้งสิ้น",
        kind: "text",
        mode: "replace",
      },
      {
        plainText: "หนึ่งพันหนึ่งร้อยสิบหกบาท",
        label: "รวมทั้งสิ้น",
        name: "รวมทั้งสิ้น_ตัวอักษร",
        kind: "text",
        mode: "replace",
      },
    ],
    footerXml,
    "th",
  );
  assert.ok(
    outFooter.some((s) => s.plainText === "1,116"),
    "unique footer total must tag even outside prototype row",
  );
  assert.ok(
    outFooter.some((s) => s.plainText === "หนึ่งพันหนึ่งร้อยสิบหกบาท"),
    "unique footer total words must tag",
  );
  // 1200 only exists on prototype — a second identical hit must not be invented from footer.
  assert.ok(
    outFooter.filter((s) => s.plainText === "1200").every((s) => {
      const at = Number(s.plainStart);
      return footerPlain.slice(at, at + 4) === "1200" && at < footerPlain.indexOf("1,116");
    }),
    "prototype price digits must not be re-tagged from nowhere",
  );
  console.log(`✓ ai-tag-draft footer-unique-total smoke (n=${outFooter.length})`);
}

// Contact enrich: phones/emails seeded when AI omits them.
const contactPlain =
  "ที่อยู่ กรุงเทพฯ โทร 02-023-2599,096-392-3963 Email biglegal@biglegalbusiness.com ปิด";
const outContact = validateAiTagSuggestions(
  contactPlain,
  [{ plainText: "กรุงเทพฯ", label: "ที่อยู่", name: "ที่อยู่", kind: "text", mode: "replace" }],
  null,
  "th",
);
assert.ok(
  outContact.some((s) => String(s.plainText).includes("02-023-2599")),
  "must enrich phone after โทร",
);
assert.ok(
  outContact.some((s) => String(s.plainText).includes("@")),
  "must enrich email",
);
console.log(`✓ ai-tag-draft contact enrich smoke (n=${outContact.length})`);

// Weak "-" must not shatter phone numbers when AI emits plainText "-".
const hyphenPlain =
  "โทร 02-023-2599,096-392-3963 คดีหมายเลขแดงที่ - จบ";
const outHyphen = validateAiTagSuggestions(
  hyphenPlain,
  [
    {
      plainText: "-",
      label: "คดีหมายเลขแดงที่",
      name: "คดีแดง",
      kind: "text",
      mode: "replace",
    },
  ],
  null,
  "th",
);
assert.equal(
  outHyphen.filter((s) => s.plainText === "-").length,
  1,
  "only the label-anchored hyphen may tag",
);
assert.ok(
  outHyphen.some((s) => String(s.plainText).includes("02-023-2599")),
  "phone must still enrich beside a hyphen field",
);
assert.ok(
  !String(outHyphen.find((s) => s.plainText === "-")?.plainStart).includes("NaN"),
  "hyphen hit has plainStart",
);
const hyp = outHyphen.find((s) => s.plainText === "-");
assert.ok(
  hyp &&
    hyphenPlain.slice(Math.max(0, hyp.plainStart - 12), hyp.plainStart).includes(
      "แดงที่",
    ),
  "hyphen must sit after คดีหมายเลขแดงที่, not inside the phone",
);
console.log(`✓ ai-tag-draft hyphen-not-shatter-phone smoke (n=${outHyphen.length})`);
