#!/usr/bin/env node
/**
 * Smoke: AI tag draft accepts list-table / wrap-row / fill-empty-tc / cell fields
 * on the FIRST data (prototype) row only; later sample rows and header stay out.
 * Run: npx tsx scripts/ai-tag-draft-table-first-row.mjs
 *
 * Sample OOXML and form strings live under fixtures/ai-tag-draft/.
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
const tf = tableFirst.expected;

const outTh = validateAiTagSuggestions(
  plain,
  tableFirst.suggestionsTh,
  xml,
  "th",
);

assert.ok(
  outTh.some((s) => s.plainText === tf.outsideText && s.kind === "text"),
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

// First column digit may sit flush against Thai cell text in TAGGER_PLAIN,
// so plain replace is rejected; enrich falls back to fill-empty-tc on cell 0
// (same as manual list-table) while still emitting a {{+…}} value field.
assert.ok(
  outTh.some(
    (s) =>
      (s.plainText === tf.firstDigit && (s.kind === "auto" || s.mode === "replace")) ||
      (s.mode === "fill-empty-tc" &&
        s.cellIndex === 0 &&
        (s.kind === "auto" || String(s.tag || "").includes("+"))),
  ),
  "first cell must get a value field (auto/replace or fill-empty-tc), not only the list marker",
);

assert.ok(
  outTh.some(
    (s) => s.plainText === tf.prototypeCell && s.kind === "text" && s.mode === "replace",
  ),
  "prototype non-empty cell should be tagged",
);

assert.ok(
  outTh.some((s) => s.mode === "fill-empty-tc" && s.cellIndex === tf.emptyCellIndex),
  "empty prototype cell under header must become fill-empty-tc",
);

assert.ok(
  !outTh.some((s) => s.plainText === tf.rejectedRowText),
  "later sample-row text must be rejected",
);
assert.ok(
  !outTh.some((s) => s.plainText === tf.rejectedDigit && s.kind === "auto"),
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
const enAuto = outEn.find(
  (s) => s.kind === "auto" || (s.plainText === tf.firstDigit && s.mode === "replace"),
);
assert.ok(enAuto, "EN: first-cell field enriched");
assert.ok(
  /^[a-z0-9_.-]+$/i.test(enAuto.name),
  `EN: first-cell name should be ASCII snake_case, got ${enAuto.name}`,
);
const enEmpty = outEn.find(
  (s) => s.mode === "fill-empty-tc" && s.cellIndex === tf.emptyCellIndex,
);
assert.ok(enEmpty, "EN: empty cell enriched");
assert.ok(
  /^[a-z0-9_.-]+$/i.test(enEmpty.name),
  `EN: empty-cell name should be ASCII snake_case, got ${enEmpty.name}`,
);

console.log(
  `✓ ai-tag-draft first-row table smoke (th=${outTh.length}, en=${outEn.length})`,
);

const multiHeader = values.multiHeader;
const multiHeaderXml = loadXml(multiHeader.xml);
const multiPlain = multiHeader.plain;
const mh = multiHeader.expected;

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
  new RegExp(mh.listNamePattern).test(seedWrap.name),
  `multi-header: list name should reflect list semantics, got ${seedWrap.name}`,
);
assert.ok(
  outSeed.some(
    (s) =>
      (s.plainText === mh.firstDigit && (s.kind === "auto" || s.mode === "replace")) ||
      (s.mode === "fill-empty-tc" &&
        s.cellIndex === 0 &&
        (s.kind === "auto" || String(s.tag || "").includes("+"))),
  ),
  "multi-header: first data cell must get a value field",
);
assert.ok(
  !outSeed.some(
    (s) => s.kind === "list-table" && new RegExp(mh.headerRejectPattern).test(s.plainText || ""),
  ),
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

const strayAuto = values.strayAuto;
const sa = strayAuto.expected;
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
  outStray.some(
    (s) => s.plainText === sa.labelText && s.kind === "text" && s.tag === sa.labelTag,
  ),
  "header-like label tagged auto must become plain text tag",
);
assert.ok(
  outStray.some(
    (s) => s.plainText === sa.digitText && s.kind === "text" && s.tag === sa.digitTag,
  ),
  "digit outside loop tagged auto must become plain text tag",
);
console.log(`✓ ai-tag-draft stray-auto demote smoke (n=${outStray.length})`);

const paragraphList = values.paragraphList;
const paraXml = loadXml(paragraphList.xml);
const paraPlain = paragraphList.plain;
const pl = paragraphList.expected;

const outPara = validateAiTagSuggestions(
  paraPlain,
  paragraphList.suggestions,
  paraXml,
  "th",
);

const paraWrap = outPara.find((s) => s.kind === "list" && s.mode === "wrap");
assert.ok(paraWrap, "paragraph list wrap must be seeded/accepted");
assert.equal(paraWrap.plainText, pl.firstUnitPlain, "wrap must be FIRST unit only");
assert.equal(paraWrap.tag, pl.wrapTag);
assert.ok(
  outPara.some(
    (s) => s.plainText === pl.innerName && s.kind === "text" && s.wrapTag === paraWrap.tag,
  ),
  "inner text field inside first unit must nest under the list wrap",
);
assert.ok(
  outPara.some(
    (s) =>
      s.plainText === pl.firstDigit &&
      s.kind === "auto" &&
      String(s.tag || "").includes("{{+") &&
      s.wrapTag === paraWrap.tag,
  ),
  "digit inside paragraph list wrap must stay auto {{+}}",
);
assert.ok(
  !outPara.some((s) => new RegExp(pl.laterUnitRejectPattern).test(s.plainText || "")),
  "later units must not get their own field tags",
);
assert.equal(
  outPara.filter((s) => s.kind === "list").length,
  1,
  "only one paragraph-list wrap per stem group",
);
console.log(`✓ ai-tag-draft paragraph-list first-unit smoke (n=${outPara.length})`);

// Word docs often put <w:tab/> between label and digit — plain must keep \\t
// or seeded list wraps never match TAGGER_PLAIN.
const paragraphTab = values.paragraphTab;
const paraTabXml = loadXml(paragraphTab.xml);
const paraTabPlain = paragraphTab.plain;
const pt = paragraphTab.expected;
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
  pt.firstUnitPlain,
  "tabbed wrap plain must retain w:tab as \\\\t",
);
assert.ok(
  !outParaTab.some((s) => s.plainText === pt.laterName),
  "later tabbed unit must stay untagged",
);
console.log(`✓ ai-tag-draft paragraph-list tabbed-unit smoke (n=${outParaTab.length})`);

const labelAnchored = values.labelAnchored;
const la = labelAnchored.expected;
const outLabel = validateAiTagSuggestions(
  labelAnchored.plain,
  labelAnchored.suggestions,
  null,
  "th",
);
const loan = outLabel.find((s) => s.plainText === la.loanValue);
assert.ok(loan, "label-anchored value must match despite \\\\t\\\\t in doc");
assert.equal(loan.labelHint, la.loanLabel);
assert.ok(
  outLabel.some((s) => s.plainText === la.registryValue && s.labelHint === la.registryLabel),
  "registry value must label-anchor",
);
assert.ok(
  !outLabel.some(
    (s) => s.plainText.includes(la.loanLabel) && s.plainText.includes(la.loanValue),
  ),
  "must tag value only, not label+value blob",
);
console.log(`✓ ai-tag-draft label-anchored tab smoke (n=${outLabel.length})`);

const assignSpace = values.assignSpace;
const as_ = assignSpace.expected;
const outAssign = validateAiTagSuggestions(
  assignSpace.plain,
  assignSpace.suggestions,
  null,
  "th",
);
const company = outAssign.find((s) =>
  String(s.plainText || "").includes(as_.companyNeedle),
);
assert.ok(company, "space-separated label → company value must match");
assert.equal(company.labelHint, as_.labelHint);
assert.ok(
  !String(company.plainText).startsWith(as_.labelHint),
  "must tag company value only, not the stem label",
);
console.log(`✓ ai-tag-draft label-anchored space smoke (n=${outAssign.length})`);

const phoneFlush = values.phoneFlush;
const pf = phoneFlush.expected;
const outPhone = validateAiTagSuggestions(
  phoneFlush.plain,
  phoneFlush.suggestions,
  null,
  "th",
);
const phone1 = outPhone.find(
  (s) => s.plainText === pf.phone && s.labelHint === pf.labelHint,
);
assert.ok(phone1, "flush glued phone after label must label-anchor to digits");
assert.ok(
  outPhone.some(
    (s) => s.plainText === pf.phoneList && s.labelHint === pf.labelHint,
  ),
  "flush multi-phone list after label must match",
);
assert.ok(
  outPhone.some((s) => s.plainText === pf.phone),
  "glued plainText label+digits without label field must still find digits",
);
console.log(`✓ ai-tag-draft label-anchored flush-phone smoke (n=${outPhone.length})`);

const flushText = values.flushText;
const ft = flushText.expected;
const outFlushText = validateAiTagSuggestions(
  flushText.plain,
  flushText.suggestions,
  null,
  "th",
);
const flushCo = outFlushText.find((s) =>
  String(s.plainText || "").includes(ft.companyNeedle),
);
assert.ok(flushCo, "flush text after assign label must match company name");
assert.equal(flushCo.labelHint, ft.labelHint);
assert.ok(
  outFlushText.some(
    (s) => s.plainText === ft.officeText && s.labelHint === ft.officeLabel,
  ),
  "flush text after phone label (not digits) must match",
);
assert.ok(
  outFlushText.some((s) => s.plainText === ft.officeText),
  "glued phone-label+office without label field must peel to text",
);
assert.ok(
  !outFlushText.some((s) => String(s.plainText).startsWith(ft.gluedOfficePrefix)),
  "must not keep phone label glued into the tagged plainText",
);
console.log(`✓ ai-tag-draft label-anchored flush-text smoke (n=${outFlushText.length})`);

const multiOccurrence = values.multiOccurrence;
const mo = multiOccurrence.expected;
const outMultiOcc = validateAiTagSuggestions(
  multiOccurrence.plain,
  multiOccurrence.suggestions,
  null,
  "th",
);
const nameHits = outMultiOcc.filter(
  (s) => s.plainText === mo.nameText && s.name === mo.fieldName,
);
assert.equal(
  nameHits.length,
  mo.hitCount,
  "one AI suggestion must expand to every safe name hit",
);
assert.ok(
  new Set(nameHits.map((s) => s.plainStart)).size === mo.hitCount,
  "expanded hits must be distinct plainStart offsets",
);
console.log(`✓ ai-tag-draft multi-occurrence expand smoke (n=${outMultiOcc.length})`);

const phoneShard = values.phoneShard;
const phoneShardPlain = phoneShard.plain;
const ps = phoneShard.expected;
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
      s.plainText === ps.digit &&
      Number.isFinite(at) &&
      phoneShardPlain.slice(Math.max(0, at - 4), at + 5).includes(ps.midPhoneFragment)
    );
  }),
  "short digit must not tag inside a landline number",
);
const threes = outPhoneShard.filter((s) => s.plainText === ps.digit);
assert.ok(threes.length >= 1, "standalone labeled digits should still match");
assert.ok(
  threes.every((s) => {
    const at = Number(s.plainStart);
    const prev = at > 0 ? phoneShardPlain[at - 1] : "";
    return !/[\d-]/.test(prev || "");
  }),
  "matched short digits must be token-bounded, not mid-phone",
);
console.log(`✓ ai-tag-draft phone-shard digit smoke (n=${outPhoneShard.length})`);

const digitFlush = values.digitFlush;
const digitFlushPlain = digitFlush.plain;
const df = digitFlush.expected;
const outDigitFlush = validateAiTagSuggestions(
  digitFlushPlain,
  digitFlush.suggestions,
  null,
  "th",
);
assert.ok(
  !outDigitFlush.some(
    (s) =>
      s.plainText === df.rejectedDigit &&
      digitFlushPlain[s.plainStart + 1] === df.rejectedNextChar,
  ),
  "single-digit row marker flush to Thai must not tag",
);
assert.ok(
  outDigitFlush.some((s) => s.plainText === df.pageSurvey),
  "4-digit page-survey flush to Thai must tag",
);
assert.ok(
  outDigitFlush.some((s) => s.plainText === df.price),
  "price digits flush to Thai words must tag",
);
console.log(`✓ ai-tag-draft digit-flush-thai smoke (n=${outDigitFlush.length})`);

{
  const footerUnique = values.footerUnique;
  const footerPlain = footerUnique.plain;
  const footerXml = loadXml(footerUnique.xml);
  const fe = footerUnique.expected;
  const outFooter = validateAiTagSuggestions(
    footerPlain,
    footerUnique.suggestions,
    footerXml,
    "th",
  );
  assert.ok(
    outFooter.some((s) => s.plainText === fe.totalDigits),
    "unique footer total must tag even outside prototype row",
  );
  assert.ok(
    outFooter.some((s) => s.plainText === fe.totalWords),
    "unique footer total words must tag",
  );
  assert.ok(
    outFooter.filter((s) => s.plainText === fe.prototypePrice).every((s) => {
      const at = Number(s.plainStart);
      return (
        footerPlain.slice(at, at + fe.prototypePrice.length) === fe.prototypePrice &&
        at < footerPlain.indexOf(fe.totalDigits)
      );
    }),
    "prototype price digits must not be re-tagged from nowhere",
  );
  console.log(`✓ ai-tag-draft footer-unique-total smoke (n=${outFooter.length})`);
}

const contactEnrich = values.contactEnrich;
const ce = contactEnrich.expected;
const outContact = validateAiTagSuggestions(
  contactEnrich.plain,
  contactEnrich.suggestions,
  null,
  "th",
);
assert.ok(
  outContact.some((s) => String(s.plainText).includes(ce.phoneNeedle)),
  "must enrich phone after phone label",
);
assert.ok(
  outContact.some((s) => String(s.plainText).includes(ce.emailMarker)),
  "must enrich email",
);
console.log(`✓ ai-tag-draft contact enrich smoke (n=${outContact.length})`);

const hyphenPhone = values.hyphenPhone;
const hyphenPlain = hyphenPhone.plain;
const hp = hyphenPhone.expected;
const outHyphen = validateAiTagSuggestions(
  hyphenPlain,
  hyphenPhone.suggestions,
  null,
  "th",
);
assert.equal(
  outHyphen.filter((s) => s.plainText === hp.hyphen).length,
  1,
  "only the label-anchored hyphen may tag",
);
assert.ok(
  outHyphen.some((s) => String(s.plainText).includes(hp.phoneNeedle)),
  "phone must still enrich beside a hyphen field",
);
assert.ok(
  !String(outHyphen.find((s) => s.plainText === hp.hyphen)?.plainStart).includes("NaN"),
  "hyphen hit has plainStart",
);
const hyp = outHyphen.find((s) => s.plainText === hp.hyphen);
assert.ok(
  hyp &&
    hyphenPlain
      .slice(Math.max(0, hyp.plainStart - hp.labelAnchorLookbehind), hyp.plainStart)
      .includes(hp.labelAnchorNeedle),
  "hyphen must sit after its label stem, not inside the phone",
);
console.log(`✓ ai-tag-draft hyphen-not-shatter-phone smoke (n=${outHyphen.length})`);
