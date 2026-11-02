#!/usr/bin/env node
/**
 * Smoke: AI tag draft accepts list-table / wrap-row / fill-empty-tc / cell fields
 * on the FIRST data (prototype) row only; later sample rows and header stay out.
 * Run: npx tsx scripts/ai-tag-draft-table-first-row.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAiTagSuggestions } from "../src/server/ai-tag-draft.ts";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "ai-tag-draft",
);

function loadXml(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function loadValues() {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, "values.json"), "utf8"));
}

const values = loadValues();

const tableFirst = values.tableFirstRow;
const xml = loadXml(tableFirst.xml);
const plain = tableFirst.plain;

const outTh = validateAiTagSuggestions(
  plain,
  tableFirst.suggestionsTh,
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
  tableFirst.suggestionsEn,
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

// Multi-row headers (long merged titles, no w:tblHeader).
// Row 0/1 are headers; row 2 with "1" is the prototype. Model may omit wrap-row.
const multiHeader = values.multiHeader;
const multiHeaderXml = loadXml(multiHeader.xml);
const multiPlain = multiHeader.plain;

// No model wrap — seeds + enrichment must still propose list-table + first cell.
const outSeed = validateAiTagSuggestions(
  multiPlain,
  multiHeader.suggestions,
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
const strayAuto = values.strayAuto;
const outStray = validateAiTagSuggestions(
  strayAuto.plain,
  strayAuto.suggestions,
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

// Paragraph list: consecutive units outside tables → wrap FIRST unit only;
// later units hard-blocked; auto inside wrap kept; stray fields on unit 2 dropped.
const paragraphList = values.paragraphList;
const paraXml = loadXml(paragraphList.xml);
const paraPlain = paragraphList.plain;

const outPara = validateAiTagSuggestions(
  paraPlain,
  paragraphList.suggestions,
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

// Real Word docs often put <w:tab/> between label and digit — plain must
// keep \\t or seeded list wraps never match TAGGER_PLAIN.
const paragraphTab = values.paragraphTab;
const paraTabXml = loadXml(paragraphTab.xml);
const paraTabPlain = paragraphTab.plain;
const outParaTab = validateAiTagSuggestions(
  paraTabPlain,
  paragraphTab.suggestions,
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
const labelAnchored = values.labelAnchored;
const outLabel = validateAiTagSuggestions(
  labelAnchored.plain,
  labelAnchored.suggestions,
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

// Space-separated prose (no \\t).
const assignSpace = values.assignSpace;
const outAssign = validateAiTagSuggestions(
  assignSpace.plain,
  assignSpace.suggestions,
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

// Flush / glued (no space): phone labels and multi-value lists.
const phoneFlush = values.phoneFlush;
const outPhone = validateAiTagSuggestions(
  phoneFlush.plain,
  phoneFlush.suggestions,
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

// Flush text (not only digits).
const flushText = values.flushText;
const outFlushText = validateAiTagSuggestions(
  flushText.plain,
  flushText.suggestions,
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
const multiOccurrence = values.multiOccurrence;
const outMultiOcc = validateAiTagSuggestions(
  multiOccurrence.plain,
  multiOccurrence.suggestions,
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

// Short digit must NOT shard a phone number.
const phoneShard = values.phoneShard;
const phoneShardPlain = phoneShard.plain;
const outPhoneShard = validateAiTagSuggestions(
  phoneShardPlain,
  phoneShard.suggestions,
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
const digitFlush = values.digitFlush;
const digitFlushPlain = digitFlush.plain;
const outDigitFlush = validateAiTagSuggestions(
  digitFlushPlain,
  digitFlush.suggestions,
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
  const footerUnique = values.footerUnique;
  const footerPlain = footerUnique.plain;
  const footerXml = loadXml(footerUnique.xml);
  const outFooter = validateAiTagSuggestions(
    footerPlain,
    footerUnique.suggestions,
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
const contactEnrich = values.contactEnrich;
const outContact = validateAiTagSuggestions(
  contactEnrich.plain,
  contactEnrich.suggestions,
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
const hyphenPhone = values.hyphenPhone;
const hyphenPlain = hyphenPhone.plain;
const outHyphen = validateAiTagSuggestions(
  hyphenPlain,
  hyphenPhone.suggestions,
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
