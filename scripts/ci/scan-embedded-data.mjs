#!/usr/bin/env node
/**
 * Scan source/test trees for committed embedded payloads and binary documents.
 * Prints path:line and rule name only; never prints matched content.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- configurable thresholds / exclusions ---
const SCAN_ROOTS = ["src", "test", "tests"];
const EXCLUDED_DIR_NAMES = new Set(["fixtures", "config", "node_modules", ".git"]);
const BINARY_DOC_EXTENSIONS = new Set([".docx", ".pdf", ".xlsx", ".zip"]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".svg",
  ".env",
  ".example",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LONG_BASE64_MIN_LENGTH = 200;
// --- end config ---

const LONG_BASE64_RE = new RegExp(
  `[A-Za-z0-9+/]{${LONG_BASE64_MIN_LENGTH},}={0,2}`,
  "g",
);
const DATA_URI_BASE64_RE = /data:[^,\s]*;base64,[A-Za-z0-9+/]{32,}={0,2}/gi;
const DOC_SIGNATURE_RE = /(?:UEsDB|JVBERi0)[A-Za-z0-9+/=]*/g;

const RULES = [
  { name: "long-base64", re: LONG_BASE64_RE },
  { name: "data-uri-base64", re: DATA_URI_BASE64_RE },
  { name: "binary-doc-signature", re: DOC_SIGNATURE_RE },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string} dir */
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (entry.isFile()) yield full;
  }
}

/** @param {string} filePath */
function shouldScanText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return true;
  if (BINARY_DOC_EXTENSIONS.has(ext)) return false;
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // skip known non-text binaries
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".bin"].includes(ext)) {
    return false;
  }
  return true;
}

/** @type {{ file: string, line: number, rule: string }[]} */
const findings = [];

for (const rootName of SCAN_ROOTS) {
  const root = path.join(repoRoot, rootName);
  if (!fs.existsSync(root)) continue;

  for (const filePath of walk(root)) {
    const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
    const ext = path.extname(filePath).toLowerCase();

    if (BINARY_DOC_EXTENSIONS.has(ext)) {
      findings.push({ file: rel, line: 1, rule: "binary-document-file" });
      continue;
    }

    if (!shouldScanText(filePath)) continue;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;

    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    // skip files that are not valid text
    if (content.includes("\u0000")) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        if (rule.re.test(line)) {
          findings.push({ file: rel, line: i + 1, rule: rule.name });
          // one report per rule per line
        }
      }
    }
  }
}

if (findings.length === 0) {
  console.log("scan-embedded-data: clean");
  process.exit(0);
}

for (const f of findings) {
  console.log(`${f.file}:${f.line}  ${f.rule}`);
}
console.error(`scan-embedded-data: ${findings.length} finding(s)`);
process.exit(1);
