#!/usr/bin/env node
/**
 * CI guard: public/*.js must parse (no duplicate declarations / SyntaxError).
 * Catches merge mistakes like duplicate pollAiJobResult that blank the home UI.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const files = readdirSync(publicDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => join(publicDir, f));

if (!files.length) {
  console.error("FAIL: no public/*.js files found");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAIL: node --check ${file}`);
    if (r.stderr) console.error(r.stderr.trim());
    if (r.stdout) console.error(r.stdout.trim());
  } else {
    console.log(`✓ node --check ${file.replace(root + "/", "")}`);
  }
}

/** Extra: known AI helpers must not be declared twice in app.js. */
import { readFileSync } from "node:fs";
const app = readFileSync(join(publicDir, "app.js"), "utf8");
for (const name of [
  "pollAiJobResult",
  "postSuggestTagsAsync",
  "ensureAiProviders",
  "applyAiStatus",
]) {
  const re = new RegExp(
    `(?:async\\s+)?function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=`,
    "g",
  );
  const n = (app.match(re) || []).length;
  if (n !== 1) {
    failed += 1;
    console.error(`FAIL: ${name} declared ${n} time(s) in public/app.js (want 1)`);
  } else {
    console.log(`✓ single ${name} in public/app.js`);
  }
}

if (failed) {
  console.error(`\n${failed} public JS syntax check(s) failed`);
  process.exit(1);
}
console.log("\npublic-js-syntax-unit-test: ok");
