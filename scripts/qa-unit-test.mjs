import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { TagDisposition, TagPlacement } from "easy-template-x";
import {
  fieldIdentityKey,
  normalizeVarName,
  validateUploadedTagName,
  validateVarName,
} from "../src/server/field-names.ts";
import {
  fillTemplate,
  parseBoolTagName,
  parseTemplate,
  tagsToFieldsWithWarnings,
} from "../src/server/docx-engine.ts";
import { mergeSplitTemplateTagsInXml } from "../src/server/docx-merge-tags.ts";
import { formatTemplateError } from "../src/server/docx-errors.ts";
import { maskGeminiKey } from "../src/server/ai-config.ts";
import {
  UNKNOWN_CLIENT_IP,
  clientIpFromXForwardedFor,
  getIpAddressHeaders,
  getPreferredIpHeaders,
  getTrustedProxyCount,
  rateLimitClientIp,
  resolveClientIp,
  trustCfConnectingIp,
  withResolvedClientIpHeaders,
} from "../src/server/client-ip.ts";
import {
  countFilledValues,
  isFilledValue,
  toFillValues,
} from "../src/server/source-map.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "..", "fixtures", "tag-parse");

async function docxFromFixture(documentXmlName) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", readFileSync(join(FIX, "content-types.xml")));
  zip.folder("_rels").file(".rels", readFileSync(join(FIX, "rels.xml")));
  zip
    .folder("word")
    .file("document.xml", readFileSync(join(FIX, documentXmlName)));
  zip
    .folder("word")
    .folder("_rels")
    .file("document.xml.rels", readFileSync(join(FIX, "document.xml.rels")));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function readDocXml(buf) {
  const zip = await JSZip.loadAsync(buf);
  return zip.file("word/document.xml").async("string");
}

console.log("qa-unit-test");

assert.equal(fieldIdentityKey(" Name "), fieldIdentityKey("name"));
assert.equal(normalizeVarName("  a   b  "), "a b");
assert.equal(validateVarName("ok_name"), null);
assert.ok(validateVarName("bad name!"));
// NFC keeps Thai sara am (U+0E33); NFKC would split it to ํ+า.
const jumnoon = "จำนวน";
assert.equal(normalizeVarName(jumnoon), jumnoon);
assert.deepEqual(
  [...normalizeVarName(jumnoon)].map((c) => c.codePointAt(0)),
  [0x0e08, 0x0e33, 0x0e19, 0x0e27, 0x0e19],
);
assert.notEqual(jumnoon.normalize("NFKC"), jumnoon);
assert.equal(validateVarName("ที่อยู่/เบอร์"), null);
assert.equal(validateUploadedTagName("เขต/อำเภอ"), null);
assert.equal(validateUploadedTagName("พบ?√,"), null);
assert.equal(validateUploadedTagName("รายการ"), null);
console.log("✓ field-names");

const tags = [
  { name: "outer", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
  { name: "a", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "inner", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
  { name: "b", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "inner", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  { name: "outer", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  { name: "Name", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "name", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: " Name ", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
];
const { fields } = tagsToFieldsWithWarnings(/** @type {any} */ (tags));
const outer = fields.find((f) => f.name === "outer");
assert.ok(outer && outer.type === "list");
assert.ok(outer.itemFields.find((f) => f.type === "list" && f.name === "inner"));
const texts = fields.filter((f) => f.type === "text");
assert.equal(texts.length, 1);
assert.ok((texts[0].aliases || []).length >= 1);
console.log("✓ tagsToFields nested+dedupe");

assert.match(formatTemplateError(new Error("Tag {{#items}} is never closed")), /แท็กเปิด/);
assert.match(formatTemplateError(new Error("Can't find end of central directory")), /เสีย|เปิดไม่ได้/);
assert.match(formatTemplateError(new Error("encrypted package https://example.com/docs")), /รหัสผ่าน/);
assert.doesNotMatch(
  formatTemplateError(new Error("see https://github.com/easy-template-x for help")),
  /https?:/,
);
console.log("✓ formatTemplateError");

const masked = maskGeminiKey("ABCDEFGHIJKLMNOPQRSTUV");
assert.ok(masked.startsWith("••••"));
assert.ok(!masked.includes("ABCDEF"));
console.log("✓ maskGeminiKey");

// --- client IP / trusted proxy hops ---
assert.equal(getTrustedProxyCount(""), 1);
assert.equal(getTrustedProxyCount(undefined), 1);
assert.equal(getTrustedProxyCount("2"), 2);
assert.equal(getTrustedProxyCount("-1"), 1);
assert.equal(getTrustedProxyCount("nope"), 1);

assert.equal(trustCfConnectingIp(""), false);
assert.equal(trustCfConnectingIp(undefined), false);
assert.equal(trustCfConnectingIp("0"), false);
assert.equal(trustCfConnectingIp("1"), true);
assert.equal(trustCfConnectingIp("true"), true);
assert.deepEqual(getPreferredIpHeaders(false), []);
assert.deepEqual(getPreferredIpHeaders(true), ["cf-connecting-ip"]);
assert.deepEqual(getIpAddressHeaders(false), ["x-forwarded-for"]);
assert.deepEqual(getIpAddressHeaders(true), [
  "cf-connecting-ip",
  "x-forwarded-for",
]);

// Single hop: rightmost (only) value is the client
assert.equal(clientIpFromXForwardedFor("203.0.113.10", 1), "203.0.113.10");
assert.equal(
  resolveClientIp(new Headers({ "x-forwarded-for": "203.0.113.10" }), {
    trustedProxyCount: 1,
    trustCfConnectingIp: false,
  }),
  "203.0.113.10",
);

// Multiple hops: skip trusted count from the right
assert.equal(
  clientIpFromXForwardedFor("198.51.100.1, 203.0.113.50, 192.0.2.10", 2),
  "203.0.113.50",
);
assert.equal(
  resolveClientIp(
    new Headers({
      "x-forwarded-for": "198.51.100.1, 203.0.113.50, 192.0.2.10",
    }),
    { trustedProxyCount: 2, trustCfConnectingIp: false },
  ),
  "203.0.113.50",
);

// Spoofed leftmost XFF must not win when proxies append
assert.equal(
  clientIpFromXForwardedFor("8.8.8.8, 203.0.113.77", 1),
  "203.0.113.77",
);
assert.notEqual(
  resolveClientIp(
    new Headers({ "x-forwarded-for": "8.8.8.8, 203.0.113.77" }),
    { trustedProxyCount: 1, trustCfConnectingIp: false },
  ),
  "8.8.8.8",
);

// Spoofed cf-connecting-ip ignored when trust is off (default)
assert.equal(
  resolveClientIp(
    new Headers({
      "cf-connecting-ip": "198.51.100.99",
      "x-forwarded-for": "8.8.8.8, 203.0.113.9",
    }),
    { trustedProxyCount: 1, trustCfConnectingIp: false },
  ),
  "203.0.113.9",
);

// cf-connecting-ip preferred over XFF only when trust is on
assert.equal(
  resolveClientIp(
    new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "8.8.8.8, 198.51.100.2",
    }),
    { trustedProxyCount: 1, trustCfConnectingIp: true },
  ),
  "203.0.113.9",
);

// No headers → null; rate-limit key must not bypass
assert.equal(
  resolveClientIp(new Headers(), { trustCfConnectingIp: false }),
  null,
);
assert.equal(rateLimitClientIp(null), UNKNOWN_CLIENT_IP);
assert.equal(rateLimitClientIp(""), UNKNOWN_CLIENT_IP);
assert.equal(rateLimitClientIp("not-an-ip"), UNKNOWN_CLIENT_IP);
assert.equal(rateLimitClientIp("203.0.113.9"), "203.0.113.9");
assert.ok(UNKNOWN_CLIENT_IP === "0.0.0.0"); // valid IP for Better Auth headers

// Header rewrite: multi-hop → single trusted value for Better Auth
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", {
      headers: { "x-forwarded-for": "8.8.8.8, 203.0.113.40" },
    }),
    { trustedProxyCount: 1, trustCfConnectingIp: false },
  );
  assert.equal(req.headers.get("x-forwarded-for"), "203.0.113.40");
  assert.equal(req.headers.get("cf-connecting-ip"), null);
}

// Fail-closed on auth path: no headers → sentinel XFF (shared rate-limit bucket)
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", { headers: {} }),
    { trustCfConnectingIp: false },
  );
  assert.equal(req.headers.get("x-forwarded-for"), UNKNOWN_CLIENT_IP);
  assert.equal(req.headers.get("cf-connecting-ip"), null);
}

// Fail-closed: unresolvable multi-hop with too many trusted hops
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", {
      headers: { "x-forwarded-for": "203.0.113.1" },
    }),
    { trustedProxyCount: 3, trustCfConnectingIp: false },
  );
  assert.equal(req.headers.get("x-forwarded-for"), UNKNOWN_CLIENT_IP);
}

// Spoofed CF header stripped when trust is off; XFF wins
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", {
      headers: {
        "cf-connecting-ip": "198.51.100.99",
        "x-forwarded-for": "8.8.8.8, 203.0.113.40",
      },
    }),
    { trustedProxyCount: 1, trustCfConnectingIp: false },
  );
  assert.equal(req.headers.get("x-forwarded-for"), "203.0.113.40");
  assert.equal(req.headers.get("cf-connecting-ip"), null);
}

// CF trusted: keep connecting-ip and collapse XFF to same value
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", {
      headers: {
        "cf-connecting-ip": "203.0.113.40",
        "x-forwarded-for": "8.8.8.8, 198.51.100.1",
      },
    }),
    { trustedProxyCount: 1, trustCfConnectingIp: true },
  );
  assert.equal(req.headers.get("cf-connecting-ip"), "203.0.113.40");
  assert.equal(req.headers.get("x-forwarded-for"), "203.0.113.40");
}
console.log("✓ client-ip resolution");

assert.equal(isFilledValue(true), true);
assert.equal(isFilledValue(false), false);
assert.equal(isFilledValue(""), false);
assert.equal(isFilledValue("  "), false);
assert.equal(isFilledValue(null), false);
assert.equal(isFilledValue(undefined), false);
assert.equal(isFilledValue([]), false);
assert.equal(isFilledValue([{}]), false);
assert.equal(isFilledValue([{ a: "" }, { b: false }]), false);
assert.equal(isFilledValue([{ a: "x" }]), true);
assert.equal(isFilledValue({ a: false, b: "" }), false);
assert.equal(isFilledValue({ a: false, b: "ok" }), true);
assert.equal(isFilledValue(0), true);

const emptyFill = countFilledValues({
  format: "docx-form-values",
  version: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  template: "t.docx",
  fields: [
    { name: "flag", type: "bool" },
    { name: "name", type: "text" },
    { name: "rows", type: "list" },
  ],
  values: { flag: false, name: "", rows: [{ item: false }, { item: "" }] },
  skip: {},
  rowSkip: {},
  images: {},
});
assert.equal(emptyFill.filled, 0);
assert.equal(emptyFill.skipped, 3);
assert.equal(emptyFill.total, 3);

const mixedFill = countFilledValues({
  format: "docx-form-values",
  version: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  template: "t.docx",
  fields: [
    { name: "flag", type: "bool" },
    { name: "name", type: "text" },
    { name: "other", type: "text" },
  ],
  values: { flag: true, name: "Ada", other: "" },
  skip: { other: true },
  rowSkip: {},
  images: {},
});
assert.equal(mixedFill.filled, 2);
assert.equal(mixedFill.skipped, 1);
console.log("✓ countFilledValues false/empty");

// --- tag-parse QA: split runs, slash names, NFC Thai, bool checkbox, bare {{/}} ---
{
  const splitXml = readFileSync(join(FIX, "split-runs.xml"), "utf8");
  const mergedXml = mergeSplitTemplateTagsInXml(splitXml);
  assert.match(mergedXml, /<w:b\/>/);
  assert.match(mergedXml, /<w:color w:val="FF0000"\/>/);
  assert.match(mergedXml, /<w:t[^>]*>\{\{name\}\}<\/w:t>/);
  assert.doesNotMatch(mergedXml, /<w:t>\{\{<\/w:t>/);

  const splitDoc = await docxFromFixture("split-runs.xml");
  const parsedSplit = await parseTemplate(splitDoc);
  assert.equal(parsedSplit.fields.length, 1);
  assert.equal(parsedSplit.fields[0].name, "name");
  const filledSplit = await fillTemplate({
    template: splitDoc,
    values: { name: "VALUE" },
    images: [],
  });
  const filledSplitXml = await readDocXml(filledSplit);
  assert.match(filledSplitXml, /VALUE/);
  assert.match(filledSplitXml, /<w:b\/>/);
  assert.match(filledSplitXml, /<w:color w:val="FF0000"\/>/);
  console.log("✓ split runs merge + fill keeps first-run formatting");
}

{
  const slashDoc = await docxFromFixture("slash-and-loop.xml");
  const parsed = await parseTemplate(slashDoc);
  assert.ok(!parsed.warnings?.length, String(parsed.warnings));
  const top = parsed.fields.find((f) => f.name === "ที่อยู่/เบอร์");
  assert.ok(top && top.type === "text");
  const list = parsed.fields.find((f) => f.name === "รายการ");
  assert.ok(list && list.type === "list");
  assert.ok(list.itemFields.some((f) => f.name === "เขต/อำเภอ"));

  const out = await fillTemplate({
    template: slashDoc,
    values: {
      "ที่อยู่/เบอร์": "99/1",
      รายการ: [{ "เขต/อำเภอ": "A/1" }, { "เขต/อำเภอ": "B/2" }],
    },
    images: [],
  });
  const xml = await readDocXml(out);
  assert.match(xml, /99\/1/);
  assert.match(xml, /A\/1/);
  assert.match(xml, /B\/2/);
  assert.doesNotMatch(xml, /\{\{/);
  console.log("✓ slash in tag names + bare {{/}} loop close");
}

{
  const thaiDoc = await docxFromFixture("thai-nfc.xml");
  const parsed = await parseTemplate(thaiDoc);
  assert.equal(parsed.fields.length, 1);
  assert.equal(parsed.fields[0].name, "จำนวน");
  assert.deepEqual(
    [...parsed.fields[0].name].map((c) => c.codePointAt(0)),
    [0x0e08, 0x0e33, 0x0e19, 0x0e27, 0x0e19],
  );
  const out = await fillTemplate({
    template: thaiDoc,
    values: { จำนวน: "42" },
    images: [],
  });
  const xml = await readDocXml(out);
  assert.match(xml, />42</);
  assert.doesNotMatch(xml, /จำนวน|จํานวน/);
  console.log("✓ Thai จำนวน NFC round-trip (parse + fill)");
}

{
  const bool = parseBoolTagName("พบ?√,");
  assert.ok(bool);
  assert.equal(bool.type, "bool");
  assert.equal(bool.label, "พบ");
  assert.equal(bool.trueText, "√");
  assert.equal(bool.falseText, "");
  assert.equal(bool.name, "พบ?√,");

  const boolDoc = await docxFromFixture("bool-checkbox.xml");
  const parsed = await parseTemplate(boolDoc);
  assert.ok(!parsed.warnings?.length, String(parsed.warnings));
  const found = parsed.fields.find((f) => f.name === "พบ?√,");
  const notFound = parsed.fields.find((f) => f.name === "ไม่พบ?√,");
  assert.ok(found && found.type === "bool");
  assert.equal(found.trueText, "√");
  assert.equal(found.falseText, "");
  assert.ok(notFound && notFound.type === "bool");

  const fillVals = toFillValues(
    parsed.fields,
    { "พบ?√,": true, "ไม่พบ?√,": false },
    {},
    {},
  );
  assert.equal(fillVals["พบ?√,"], "√");
  assert.equal(fillVals["ไม่พบ?√,"], "");

  const outTrue = await fillTemplate({
    template: boolDoc,
    values: fillVals,
    images: [],
  });
  const xmlTrue = await readDocXml(outTrue);
  assert.match(xmlTrue, /√/);

  const outFalse = await fillTemplate({
    template: boolDoc,
    values: toFillValues(
      parsed.fields,
      { "พบ?√,": false, "ไม่พบ?√,": true },
      {},
      {},
    ),
    images: [],
  });
  const xmlFalse = await readDocXml(outFalse);
  assert.match(xmlFalse, /√/);
  console.log("✓ bool checkbox {{พบ?√,}} parse + fill");
}

console.log("\nAll qa unit tests passed");
