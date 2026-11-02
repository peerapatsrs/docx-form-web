#!/usr/bin/env node
/**
 * Minify static client assets under /public for production.
 * Source files stay readable in the repo; build overwrites the copies that ship.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  { file: "public/ui-labels.js", loader: "js" },
  { file: "public/app.js", loader: "js" },
  { file: "public/style.css", loader: "css" },
];

for (const t of targets) {
  const abs = join(root, t.file);
  if (!existsSync(abs)) {
    console.warn(`skip missing ${t.file}`);
    continue;
  }
  const source = readFileSync(abs, "utf8");
  const out = transformSync(source, {
    loader: t.loader,
    minify: true,
    legalComments: "none",
    sourcemap: false,
    target: ["es2018"],
  });
  writeFileSync(abs, out.code);
  const before = Buffer.byteLength(source, "utf8");
  const after = Buffer.byteLength(out.code, "utf8");
  console.log(
    `minified ${t.file}: ${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB`,
  );
}
