#!/usr/bin/env node
/**
 * Recompute sha256 of every file under a vendored mw-shared tree and compare
 * against MW_SHARED_PIN.json. Fails on missing, extra, or changed files.
 *
 * Usage (from an app repo root):
 *   node scripts/mw-shared-verify.mjs
 *   node scripts/mw-shared-verify.mjs vendor/mw-shared
 *
 * The pin file itself is excluded from the comparison.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const PIN_FILENAME = "MW_SHARED_PIN.json";

function toPosix(p) {
  return p.split(sep).join("/");
}

function walkFiles(dir, root, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, root, out);
      continue;
    }
    if (ent.isFile()) {
      out.push(toPosix(relative(root, full)));
    }
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const vendorDir = resolve(process.argv[2] ?? "vendor/mw-shared");
const pinPath = join(vendorDir, PIN_FILENAME);

let pin;
try {
  pin = JSON.parse(readFileSync(pinPath, "utf8"));
} catch (err) {
  console.error(`mw-shared-verify: cannot read ${pinPath}: ${err.message}`);
  process.exit(1);
}

if (pin.files == null || typeof pin.files !== "object" || Array.isArray(pin.files)) {
  console.error("mw-shared-verify: pin is missing a files map");
  process.exit(1);
}

const expected = pin.files;
const expectedPaths = Object.keys(expected).sort();
const actualPaths = [];
try {
  walkFiles(vendorDir, vendorDir, actualPaths);
} catch (err) {
  console.error(`mw-shared-verify: cannot walk ${vendorDir}: ${err.message}`);
  process.exit(1);
}
actualPaths.sort();

const actualSet = new Set(actualPaths);
const expectedSet = new Set(expectedPaths);

const missing = expectedPaths.filter((p) => !actualSet.has(p));
const extra = actualPaths.filter((p) => p !== PIN_FILENAME && !expectedSet.has(p));
const changed = [];

for (const p of expectedPaths) {
  if (!actualSet.has(p)) continue;
  const got = sha256File(join(vendorDir, p));
  const want = expected[p] && expected[p].sha256;
  if (typeof want !== "string" || got !== want) {
    changed.push({ path: p, expected: want ?? "(missing sha256)", actual: got });
  }
}

if (missing.length || extra.length || changed.length) {
  if (missing.length) {
    console.error("Missing files:");
    for (const p of missing) console.error(`  - ${p}`);
  }
  if (extra.length) {
    console.error("Extra files:");
    for (const p of extra) console.error(`  - ${p}`);
  }
  if (changed.length) {
    console.error("Changed files:");
    for (const c of changed) {
      console.error(`  - ${c.path}`);
      console.error(`      expected ${c.expected}`);
      console.error(`      actual   ${c.actual}`);
    }
  }
  console.error(
    `mw-shared vendor verify failed: ${missing.length} missing, ${extra.length} extra, ${changed.length} changed`,
  );
  process.exit(1);
}

const commit = typeof pin.commit === "string" ? pin.commit : "unknown";
console.log(
  `mw-shared vendor verify passed: ${expectedPaths.length} files match pin (commit ${commit})`,
);
