#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLegacyHomeRedirectPath,
  LEGACY_HOME_REDIRECT_PATHS,
  normalizeLegacyPathname,
} from "../src/lib/legacy-routes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}

console.log("legacy-routes-unit-test");

for (const p of LEGACY_HOME_REDIRECT_PATHS) {
  check(`${p} is legacy`, () => {
    assert.equal(isLegacyHomeRedirectPath(p), true);
    assert.equal(isLegacyHomeRedirectPath(`${p}/`), true);
  });
}

check("root is not legacy", () => {
  assert.equal(isLegacyHomeRedirectPath("/"), false);
  assert.equal(isLegacyHomeRedirectPath("/login"), false);
});

check("normalizeLegacyPathname strips trailing slash", () => {
  assert.equal(normalizeLegacyPathname("/form/"), "/form");
});

check("next.config registers redirects via LEGACY_HOME_REDIRECT_PATHS", () => {
  const src = readFileSync(path.join(root, "next.config.ts"), "utf8");
  assert.match(src, /LEGACY_HOME_REDIRECT_PATHS/);
  assert.match(src, /async redirects\s*\(/);
  assert.match(src, /destination:\s*"\//);
});

check("proxy.ts redirects legacy paths before next()", () => {
  const src = readFileSync(path.join(root, "src/proxy.ts"), "utf8");
  assert.match(src, /isLegacyHomeRedirectPath/);
  assert.match(src, /NextResponse\.redirect/);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll legacy-routes unit tests passed.");
