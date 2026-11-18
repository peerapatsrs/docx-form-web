#!/usr/bin/env node
/**
 * DEF-BE-UPLOAD-BODY-LIMIT-10MB — shared upload limits + Next.js body config.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_TOO_LARGE,
  FILE_TOO_LARGE_MESSAGE,
  MAX_DOCX_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MULTIPART_BODY_OVERHEAD_BYTES,
  UPLOAD_TOO_LARGE_STATUS,
  checkUploadSizeLimits,
  isContentLengthTooLarge,
  isFileSizeTooLarge,
  uploadTooLargeBody,
} from "../src/lib/upload-limits.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log("upload-limits-unit-test");

assert.equal(MAX_DOCX_BYTES, 25 * 1024 * 1024);
assert.equal(
  MAX_UPLOAD_BODY_BYTES,
  MAX_DOCX_BYTES + MULTIPART_BODY_OVERHEAD_BYTES,
);
assert.ok(MULTIPART_BODY_OVERHEAD_BYTES > 0);
assert.ok(MAX_UPLOAD_BODY_BYTES > 10 * 1024 * 1024, "must exceed Next default 10MB");
console.log("✓ constants");

assert.equal(isFileSizeTooLarge(MAX_DOCX_BYTES), false);
assert.equal(isFileSizeTooLarge(MAX_DOCX_BYTES + 1), true);
assert.equal(isFileSizeTooLarge(11 * 1024 * 1024), false);
assert.equal(isFileSizeTooLarge(26 * 1024 * 1024), true);

assert.equal(isContentLengthTooLarge(MAX_UPLOAD_BODY_BYTES), false);
assert.equal(isContentLengthTooLarge(MAX_UPLOAD_BODY_BYTES + 1), true);
// 26MB file + multipart headers exceed body budget (file alone equals budget).
assert.equal(
  isContentLengthTooLarge(26 * 1024 * 1024 + MULTIPART_BODY_OVERHEAD_BYTES),
  true,
);
assert.equal(isContentLengthTooLarge(0), false);
console.log("✓ size predicates");

{
  const ok = checkUploadSizeLimits({
    contentLengthHeader: String(11 * 1024 * 1024),
    fileSize: 11 * 1024 * 1024,
  });
  assert.equal(ok, null);
}

{
  const hit = checkUploadSizeLimits({
    contentLengthHeader: String(26 * 1024 * 1024 + 4096),
    code: "BATCH_FILL_TOO_LARGE",
  });
  assert.ok(hit);
  assert.equal(hit.status, UPLOAD_TOO_LARGE_STATUS);
  assert.equal(hit.body.code, "BATCH_FILL_TOO_LARGE");
  assert.equal(hit.body.error, FILE_TOO_LARGE_MESSAGE);
}

{
  const hit = checkUploadSizeLimits({
    fileSize: 26 * 1024 * 1024,
    code: FILE_TOO_LARGE,
  });
  assert.ok(hit);
  assert.equal(hit.body.code, FILE_TOO_LARGE);
}

{
  const body = uploadTooLargeBody();
  assert.equal(body.code, FILE_TOO_LARGE);
}
console.log("✓ checkUploadSizeLimits");

{
  const cfg = readFileSync(join(root, "next.config.ts"), "utf8");
  assert.match(cfg, /proxyClientMaxBodySize/);
  assert.match(cfg, /MAX_UPLOAD_BODY_BYTES/);
  assert.match(cfg, /upload-limits/);
  assert.doesNotMatch(cfg, /middlewareClientMaxBodySize/);
}
console.log("✓ next.config.ts experimental.proxyClientMaxBodySize");

{
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /checkUploadSizeLimits|rejectUploadTooLarge/);
  assert.ok(api.includes("@/lib/upload-limits"));
  assert.doesNotMatch(api, /const MAX_DOCX_BYTES\s*=\s*25\s*\*\s*1024/);
  for (const route of [
    'api.post("/parse"',
    'api.post("/fill"',
    'api.post("/template/tag"',
    'api.post("/batch-fill"',
  ]) {
    assert.ok(api.includes(route), route);
  }
  assert.match(api, /BATCH_FILL_TOO_LARGE/);
  assert.match(api, /FILE_TOO_LARGE/);
  // batch-fill Content-Length gate before formData
  const batchIdx = api.indexOf('api.post("/batch-fill"');
  const chunk = api.slice(batchIdx, batchIdx + 2500);
  const earlyPos = chunk.indexOf("rejectUploadTooLarge");
  const formPos = chunk.indexOf("formData()");
  assert.ok(earlyPos >= 0 && formPos > earlyPos);
}
console.log("✓ api.ts shared size gate on upload routes");

console.log("upload-limits-unit-test: ok");
