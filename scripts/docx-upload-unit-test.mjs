#!/usr/bin/env node
/**
 * DEF-BE-PARSE-OCTET-STREAM-BYPASS — filename + OOXML package validation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  UNSUPPORTED_FILE_TYPE,
  WORDPROCESSINGML_DOCUMENT_MAIN,
  hasDocxFilename,
  hasZipPkSignature,
  isWordprocessingMlDocumentPackage,
  unsupportedFileTypeBody,
  validateDocxUpload,
} from "../src/server/docx-upload.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const FIX = join(root, "fixtures", "tag-parse");

const DOCUMENT_CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="${WORDPROCESSINGML_DOCUMENT_MAIN}"/>
</Types>`;

const TEMPLATE_CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"/>
</Types>`;

const RELS = readFileSync(join(FIX, "rels.xml"));
const DOC_XML = Buffer.from(
  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{name}}</w:t></w:r></w:p></w:body></w:document>`,
);

async function zipWithContentTypes(contentTypesXml) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.folder("_rels").file(".rels", RELS);
  zip.folder("word").file("document.xml", DOC_XML);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

console.log("docx-upload-unit-test");

assert.equal(hasDocxFilename({ name: "a.docx" }), true);
assert.equal(hasDocxFilename({ name: "A.DOCX" }), true);
assert.equal(hasDocxFilename({ name: "a.pdf" }), false);
assert.equal(hasDocxFilename({ name: "a.dotx" }), false);
assert.equal(hasDocxFilename({ name: "a.doc" }), false);
assert.equal(hasDocxFilename({ name: "docx" }), false);
console.log("✓ hasDocxFilename");

assert.equal(hasZipPkSignature(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
assert.equal(hasZipPkSignature(Buffer.from([0x00, 0x00])), false);
assert.equal(hasZipPkSignature(Buffer.alloc(0)), false);
console.log("✓ hasZipPkSignature");

const validDocx = await zipWithContentTypes(DOCUMENT_CT);
const templateDotx = await zipWithContentTypes(TEMPLATE_CT);
const nonZip = Buffer.from("%PDF-1.4 not a zip");

assert.equal(await isWordprocessingMlDocumentPackage(validDocx), true);
assert.equal(await isWordprocessingMlDocumentPackage(templateDotx), false);
assert.equal(await isWordprocessingMlDocumentPackage(nonZip), false);
console.log("✓ isWordprocessingMlDocumentPackage");

{
  const ok = await validateDocxUpload(
    { name: "form.docx", type: "application/octet-stream" },
    validDocx,
  );
  assert.equal(ok.ok, true);
}

{
  // Valid OOXML bytes but renamed to .pdf + octet-stream — must reject.
  const bad = await validateDocxUpload(
    { name: "form.pdf", type: "application/octet-stream" },
    validDocx,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // .dotx template package (even as octet-stream) — must reject.
  const bad = await validateDocxUpload(
    { name: "form.dotx", type: "application/octet-stream" },
    templateDotx,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // .dotx content renamed to .docx — still reject (template Content_Types).
  const bad = await validateDocxUpload(
    { name: "sneaky.docx", type: "application/octet-stream" },
    templateDotx,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // Correct name but non-ZIP body — reject.
  const bad = await validateDocxUpload(
    { name: "form.docx", type: "application/octet-stream" },
    nonZip,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // 0-byte .docx name — reject.
  const bad = await validateDocxUpload(
    { name: "empty.docx" },
    Buffer.alloc(0),
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // PK-only (local header bytes, no central directory) — reject.
  const pkOnly = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const bad = await validateDocxUpload({ name: "pk.docx" }, pkOnly);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // Truncated valid package — reject.
  const truncated = validDocx.subarray(0, Math.min(64, validDocx.length - 1));
  assert.ok(truncated.length < validDocx.length);
  const bad = await validateDocxUpload({ name: "cut.docx" }, truncated);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // Corrupt ZIP with PK magic but garbage — reject.
  const corrupt = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(64, 0xff),
  ]);
  const bad = await validateDocxUpload({ name: "corrupt.docx" }, corrupt);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  // .docx-named plain ZIP without Word Content_Types — reject.
  const plainZip = new JSZip();
  plainZip.file("readme.txt", "not a word package");
  const plainBuf = Buffer.from(await plainZip.generateAsync({ type: "nodebuffer" }));
  const bad = await validateDocxUpload({ name: "plain.docx" }, plainBuf);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, UNSUPPORTED_FILE_TYPE);
}

{
  const body = unsupportedFileTypeBody();
  assert.equal(body.code, UNSUPPORTED_FILE_TYPE);
  assert.ok(body.error.length > 0);
}
console.log(
  "✓ validateDocxUpload (pdf / dotx / octet-stream / 0-byte / PK-only / truncated / corrupt / valid docx)",
);

// api.ts must use the shared validator (no MIME octet-stream bypass for docx).
{
  const apiSrc = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(apiSrc, /validateDocxUpload/);
  assert.match(apiSrc, /unsupportedFileTypeBody/);
  assert.doesNotMatch(
    apiSrc,
    /function isDocx\s*\(/,
    "legacy isDocx helper must be removed",
  );
  // Old isDocx treated octet-stream alone as docx — that pattern must be gone.
  assert.doesNotMatch(
    apiSrc,
    /wordprocessingml\.document"\s*\|\|\s*[\s\S]*?octet-stream/,
  );

  // DEF-BE-SUGGEST-TAGS-VALIDATES-AFTER-AI-KEY: file validation before AI creds.
  const suggestIdx = apiSrc.indexOf('api.post("/template/suggest-tags"');
  assert.ok(suggestIdx >= 0, "suggest-tags route present");
  const suggestChunk = apiSrc.slice(suggestIdx, suggestIdx + 4500);
  const validatePos = suggestChunk.indexOf("validateDocxUpload");
  const credsPos = suggestChunk.indexOf("resolveRouteAiCredentials");
  const premiumPos = suggestChunk.indexOf("requirePremium");
  assert.ok(validatePos >= 0, "suggest-tags calls validateDocxUpload");
  assert.ok(credsPos >= 0, "suggest-tags resolves AI credentials");
  assert.ok(
    validatePos < credsPos,
    "suggest-tags must validateDocxUpload before resolveRouteAiCredentials",
  );
  assert.ok(
    validatePos < premiumPos || premiumPos < 0,
    "suggest-tags must validateDocxUpload before requirePremium",
  );

  // batch-fill 400 envelope includes top-level code.
  const batchIdx = apiSrc.indexOf('api.post("/batch-fill"');
  assert.ok(batchIdx >= 0);
  const batchChunk = apiSrc.slice(batchIdx, batchIdx + 8000);
  assert.match(batchChunk, /code:\s*"BATCH_FILL_FAILED"/);
  assert.match(batchChunk, /unsupportedFileTypeBody\(\)/);
  const batchValidatePos = batchChunk.indexOf("validateDocxUpload");
  const batchPremiumPos = batchChunk.indexOf("requirePremium");
  assert.ok(batchValidatePos >= 0 && batchPremiumPos >= 0);
  assert.ok(
    batchValidatePos < batchPremiumPos,
    "batch-fill must validate templates before requirePremium",
  );
}
console.log("✓ api.ts order + batch-fill code envelope");

console.log("docx-upload-unit-test: ok");
