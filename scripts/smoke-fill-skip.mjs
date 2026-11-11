#!/usr/bin/env node
/**
 * HTTP smoke: POST /api/fill with skip + empty loop; assert no leftover tags in output.
 *   BASE_URL=http://127.0.0.1:3000 node scripts/smoke-fill-skip.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const samplePath = join(__dirname, "..", "public/examples/sample-quote.docx");

console.log(`smoke-fill-skip → ${BASE}`);

const health = await fetch(`${BASE}/api/health`);
if (!health.ok) {
  console.error("health failed");
  process.exit(1);
}

const buf = readFileSync(samplePath);
const parseFd = new FormData();
parseFd.append(
  "file",
  new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }),
  "sample-quote.docx",
);
const parsed = await fetch(`${BASE}/api/parse`, { method: "POST", body: parseFd });
const parseJson = await parsed.json();
if (!parsed.ok) {
  console.error("parse failed", parseJson);
  process.exit(1);
}
const fields = parseJson.fields || [];
const values = {};
const skip = {};
for (const f of fields) {
  skip[f.name] = true;
  values[f.name] = f.type === "list" ? [] : f.type === "bool" ? false : "";
}

const fillFd = new FormData();
fillFd.append(
  "file",
  new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }),
  "sample-quote.docx",
);
fillFd.append("values", JSON.stringify(values));
fillFd.append("skip", JSON.stringify(skip));
fillFd.append("rowSkip", JSON.stringify({}));

const t0 = Date.now();
const res = await fetch(`${BASE}/api/fill`, { method: "POST", body: fillFd });
const durationMs = Date.now() - t0;
console.log(`fill status=${res.status} durationMs=${durationMs}`);
if (!res.ok) {
  const err = await res.text();
  console.error(err.slice(0, 400));
  process.exit(1);
}
const outBuf = Buffer.from(await res.arrayBuffer());
const zip = await JSZip.loadAsync(outBuf);
const xml = await zip.file("word/document.xml").async("string");
const badText = /<w:t[^>]*>\{\{/.test(xml);
const badLoop = /\{\{#|\{\{\//.test(xml);
if (badText || badLoop) {
  console.error("leftover tags in output");
  process.exit(1);
}
console.log("✓ no leftover text/loop tags in filled docx");
console.log("smoke-fill-skip: ok");
