import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import JSZip from "jszip";
import { TagDisposition, TagPlacement } from "easy-template-x";
import {
  VAR_NAME_RE,
  VAR_NAME_RE_SOURCE,
  fieldIdentityKey,
  isValidVarName,
  lookupCompatKey,
  lookupCompatValue,
  normalizeVarName,
  projectValuesOntoFields,
  validateUploadedTagName,
  validateVarName,
} from "../src/server/field-names.ts";
import {
  assertTagsBalanced,
  expandAliasValues,
  fillTemplate,
  parseBoolTagName,
  parseTemplate,
  tagsToFieldsWithWarnings,
} from "../src/server/docx-engine.ts";
import { mergeSplitTemplateTagsInXml } from "../src/server/docx-merge-tags.ts";
import { formatTemplateError } from "../src/server/docx-errors.ts";
import { maskGeminiKey } from "../src/server/ai-config.ts";
import {
  validateListCloseTag,
  validateListOpenTag,
} from "../src/server/template-tagger.ts";
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
import { extractDocumentLayout } from "../src/server/docx-layout.ts";

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
assert.equal(isValidVarName("ที่อยู่/เบอร์"), true);
assert.equal(validateUploadedTagName("เขต/อำเภอ"), null);
assert.equal(validateUploadedTagName("พบ?√,"), null);
assert.equal(validateUploadedTagName("รายการ"), null);
// Leading / trailing / double slash must not pass (collide with {{/…}}).
for (const bad of ["/x", "x/", "x//y", "/", "//", "/x/", "a//b"]) {
  assert.equal(isValidVarName(bad), false, `expected reject ${bad}`);
  assert.ok(validateVarName(bad), `expected error for ${bad}`);
}
assert.equal(validateListCloseTag("{{/}}"), null);
assert.equal(validateListCloseTag("{{/loop}}"), null);
assert.equal(validateListOpenTag("{{#loop}}"), null);
assert.ok(validateListCloseTag("{{/x//y}}"));
{
  const closeTags = [
    { name: "loop", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
    { name: "item", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
    { name: "loop", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  ];
  assert.doesNotThrow(() => assertTagsBalanced(/** @type {any} */ (closeTags)));
  const bareClose = [
    { name: "loop", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
    { name: "", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  ];
  assert.doesNotThrow(() => assertTagsBalanced(/** @type {any} */ (bareClose)));
}
console.log("✓ field-names");

// Client public/field-names.js must mirror server VAR_NAME_RE_SOURCE.
{
  const clientSrc = readFileSync(
    join(__dirname, "..", "public", "field-names.js"),
    "utf8",
  );
  const m = /FIELD_NAME_RE_SOURCE\s*=\s*String\.raw`([^`]+)`/.exec(clientSrc);
  assert.ok(m, "public/field-names.js must define FIELD_NAME_RE_SOURCE");
  assert.equal(m[1], VAR_NAME_RE_SOURCE);
  // Classic browser script — evaluate into this context like a <script> tag.
  vm.runInThisContext(clientSrc, { filename: "public/field-names.js" });
  const client = /** @type {any} */ (globalThis).DocxFieldNames;
  assert.ok(client?.isValidFieldName);
  assert.equal(client.FIELD_NAME_RE_SOURCE, VAR_NAME_RE_SOURCE);
  assert.equal(client.FIELD_NAME_RE.source, VAR_NAME_RE.source);
  assert.equal(client.isValidFieldName("ที่อยู่/เบอร์"), true);
  assert.equal(VAR_NAME_RE.test("ที่อยู่/เบอร์"), true);
  for (const bad of ["/x", "x/", "x//y", "/"]) {
    assert.equal(client.isValidFieldName(bad), false, `client reject ${bad}`);
    assert.equal(VAR_NAME_RE.test(bad), false, `server reject ${bad}`);
  }
  // NFC on client before validate
  const nfcName = "จำนวน";
  assert.equal(client.normalizeFieldName(nfcName), nfcName);
  assert.equal(client.isValidFieldName(nfcName), true);
  assert.equal(typeof client.lookupCompatValue, "function");
  assert.equal(typeof client.projectValuesOntoFields, "function");
  console.log("✓ client/server field-name rules in sync");
}

// Home page must load field-names.js before app.js (no standalone HTML; Next injects).
{
  const pageSrc = readFileSync(
    join(__dirname, "..", "src", "app", "page.tsx"),
    "utf8",
  );
  assert.match(pageSrc, /field-names\.js/);
  assert.match(pageSrc, /\/app\.js\?v=/);
  // Runtime order: create field-names → onload → loadAppAfterFieldNames → append app.js.
  assert.match(
    pageSrc,
    /names\.onload\s*=\s*\(\)\s*=>\s*loadAppAfterFieldNames\(\)/,
  );
  assert.match(
    pageSrc,
    /function loadAppAfterFieldNames|const loadAppAfterFieldNames/,
  );
  const minifySrc = readFileSync(
    join(__dirname, "..", "scripts", "minify-public.mjs"),
    "utf8",
  );
  const minifyNames = minifySrc.indexOf("public/field-names.js");
  const minifyApp = minifySrc.indexOf("public/app.js");
  assert.ok(
    minifyNames >= 0 && minifyApp > minifyNames,
    "minify-public lists field-names.js before app.js",
  );
  console.log("✓ field-names.js load order (page.tsx + minify-public)");
}

// Legacy NFKC keys (ํ+า) must resolve onto current NFC field names.
{
  const nfc = "จำนวน";
  const nfkc = nfc.normalize("NFKC");
  assert.notEqual(nfc, nfkc);
  assert.ok([...nfkc].includes("\u0E4D"));

  const bag = { [nfkc]: "42" };
  assert.equal(lookupCompatKey(bag, nfc), nfkc);
  assert.equal(lookupCompatValue(bag, nfc).value, "42");
  assert.equal(lookupCompatValue(bag, nfc).hit, true);
  // Exact wins over NFKC twin.
  const both = { [nfc]: "new", [nfkc]: "old" };
  assert.equal(lookupCompatKey(both, nfc), nfc);
  assert.equal(lookupCompatValue(both, nfc).value, "new");
  // Unique NFKC fallback still works when only one non-exact key matches.
  assert.equal(lookupCompatKey({ [nfkc]: "a" }, nfc), nfkc);

  // Ambiguous: two distinct non-exact keys that both NFKC-equal the field —
  // fullwidth Latin A + NFKC(จำนวน) vs ASCII A + NFKC(จำนวน). Neither equals
  // the NFC field name, so lookup must return null (do not guess).
  const collideField = "Aจำนวน";
  const collideKeyFullwidth = `\uFF21${nfc.normalize("NFKC")}`;
  const collideKeyAscii = `A${nfc.normalize("NFKC")}`;
  assert.notEqual(collideKeyFullwidth, collideField);
  assert.notEqual(collideKeyAscii, collideField);
  assert.notEqual(collideKeyFullwidth, collideKeyAscii);
  assert.equal(
    collideKeyFullwidth.normalize("NFKC"),
    collideField.normalize("NFKC"),
  );
  assert.equal(
    collideKeyAscii.normalize("NFKC"),
    collideField.normalize("NFKC"),
  );
  const collideBag = {
    [collideKeyFullwidth]: "fullwidth",
    [collideKeyAscii]: "ascii",
  };
  assert.equal(lookupCompatKey(collideBag, collideField), null);
  assert.deepEqual(lookupCompatValue(collideBag, collideField), {
    hit: false,
    key: null,
    value: undefined,
  });

  const black = "คดีหมายเลขดำที่";
  const blackNfkc = black.normalize("NFKC");
  assert.notEqual(black, blackNfkc);
  const loop = "รายการจำเลย";
  const loopNfkc = loop.normalize("NFKC");
  assert.notEqual(loop, loopNfkc);

  const projected = projectValuesOntoFields(
    [
      { name: black, type: "text" },
      {
        name: loop,
        type: "list",
        itemFields: [{ name: "ชื่อ", type: "text" }],
      },
    ],
    {
      [blackNfkc]: "ด.123/2567",
      [loopNfkc]: [{ ชื่อ: "สมชาย" }, { ชื่อ: "สมหญิง" }],
    },
  );
  assert.equal(projected[black], "ด.123/2567");
  assert.ok(Array.isArray(projected[loop]));
  assert.equal(projected[loop][0].ชื่อ, "สมชาย");
  assert.equal(projected[loop][1].ชื่อ, "สมหญิง");

  const client = /** @type {any} */ (globalThis).DocxFieldNames;
  assert.equal(client.lookupCompatValue({ [nfkc]: "9" }, nfc).value, "9");
  assert.equal(
    client.projectValuesOntoFields([{ name: nfc, type: "text" }], { [nfkc]: "9" })[
      nfc
    ],
    "9",
  );
  // Same ambiguous collision must not guess on the JS helper either.
  assert.equal(client.lookupCompatKey(collideBag, collideField), null);
  assert.deepEqual(client.lookupCompatValue(collideBag, collideField), {
    hit: false,
    key: null,
    value: undefined,
  });
  console.log("✓ NFKC compat lookup (จำนวน / คดีหมายเลขดำที่ / รายการจำเลย + collision)");
}

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
  assert.equal(req.headers.get("x-real-ip"), null);
  assert.equal(req.url, "http://localhost/api/auth/ok");
  assert.equal(req.method, "GET");
}

// No IP headers must not throw (covers the auth get-session fail-closed path)
{
  assert.doesNotThrow(() =>
    withResolvedClientIpHeaders(
      new Request("http://localhost/api/auth/get-session"),
      { trustCfConnectingIp: false },
    ),
  );
}

// Foreign Request brand: `new Request(request, { headers })` can throw across
// realms / NextRequest brands; rebuild-from-primitives must still succeed.
{
  const real = new Request("http://localhost/api/auth/get-session", {
    headers: { "x-forwarded-for": "203.0.113.77" },
  });
  const foreign = Object.create(Request.prototype, {
    url: { get: () => real.url },
    method: { get: () => "GET" },
    headers: { get: () => real.headers },
    body: { get: () => null },
    bodyUsed: { get: () => false },
  });
  assert.throws(
    () => new Request(/** @type {any} */ (foreign), { headers: new Headers() }),
  );
  const rewritten = withResolvedClientIpHeaders(
    /** @type {any} */ (foreign),
    { trustedProxyCount: 1, trustCfConnectingIp: false },
  );
  assert.equal(rewritten.headers.get("x-forwarded-for"), "203.0.113.77");
  assert.equal(rewritten.url, "http://localhost/api/auth/get-session");
}

// POST body path: rebuild keeps method and does not throw
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/dev/login-as", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.8",
      },
      body: JSON.stringify({ email: "dev@example.com" }),
    }),
    { trustedProxyCount: 1, trustCfConnectingIp: false },
  );
  assert.equal(req.method, "POST");
  assert.equal(req.headers.get("x-forwarded-for"), "203.0.113.8");
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

{
  const compatDoc = await docxFromFixture("nfc-compat-fill.xml");
  const parsed = await parseTemplate(compatDoc);
  const nfcAmount = "จำนวน";
  const nfcBlack = "คดีหมายเลขดำที่";
  const nfcLoop = "รายการจำเลย";
  assert.ok(parsed.fields.some((f) => f.name === nfcAmount));
  assert.ok(parsed.fields.some((f) => f.name === nfcBlack));
  assert.ok(parsed.fields.some((f) => f.name === nfcLoop && f.type === "list"));

  const legacyValues = {
    [nfcAmount.normalize("NFKC")]: "100",
    [nfcBlack.normalize("NFKC")]: "ด.999/2568",
    [nfcLoop.normalize("NFKC")]: [{ ชื่อ: "จำเลย ก" }, { ชื่อ: "จำเลย ข" }],
  };

  const remapped = expandAliasValues(parsed.fields, legacyValues);
  assert.equal(remapped[nfcAmount], "100");
  assert.equal(remapped[nfcBlack], "ด.999/2568");
  assert.equal(remapped[nfcLoop][0].ชื่อ, "จำเลย ก");

  const filledFromLegacy = toFillValues(
    parsed.fields,
    legacyValues,
    { [nfcAmount.normalize("NFKC")]: false },
    {},
  );
  assert.equal(filledFromLegacy[nfcAmount], "100");
  assert.equal(filledFromLegacy[nfcBlack], "ด.999/2568");
  assert.ok(Array.isArray(filledFromLegacy[nfcLoop]));
  assert.equal(filledFromLegacy[nfcLoop].length, 2);

  const out = await fillTemplate({
    template: compatDoc,
    values: legacyValues,
    images: [],
  });
  const xml = await readDocXml(out);
  assert.match(xml, />100</);
  assert.match(xml, /ด\.999\/2568/);
  assert.match(xml, /จำเลย ก/);
  assert.match(xml, /จำเลย ข/);
  assert.doesNotMatch(xml, /\{\{/);
  console.log("✓ API fill + toFillValues with legacy NFKC keys (scalar + loop)");
}

{
  const sampleBuf = readFileSync(
    new URL("../public/examples/sample-quote.docx", import.meta.url),
  );
  const layout = await extractDocumentLayout(sampleBuf);
  const imageBlock = layout.blocks.find((b) => b.type === "image");
  assert.ok(imageBlock, "sample quote should expose an image layout block");
  assert.equal(imageBlock.fieldName, "logo");
  assert.equal(imageBlock.label, "โลโก้");
  console.log("✓ extractDocumentLayout image field + nearby label");
}

console.log("\nAll qa unit tests passed");
