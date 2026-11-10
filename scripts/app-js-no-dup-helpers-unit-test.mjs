#!/usr/bin/env node
/**
 * Guard: merge conflict must not leave duplicate top-level field-name helpers
 * in public/app.js (ES module SyntaxError → empty #app / missing menus).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "public/app.js"), "utf8");

const HELPERS = [
  "docxFieldNames",
  "normalizeFieldName",
  "isValidFieldName",
  "fieldNameAllowedHint",
  "lookupCompatValue",
  "projectValuesOntoFields",
  "projectFlatOntoFields",
];

/** @param {string} name */
function topLevelFnCount(name) {
  const re = new RegExp(`^function\\s+${name}\\s*\\(`, "gm");
  return (src.match(re) || []).length;
}

let failed = 0;
for (const name of HELPERS) {
  const n = topLevelFnCount(name);
  if (n !== 1) {
    console.error(`FAIL: function ${name} declared ${n} time(s) (want 1)`);
    failed += 1;
  }
}

if (failed) {
  process.exit(1);
}
console.log("ok: public/app.js has single copies of field-name helpers");
