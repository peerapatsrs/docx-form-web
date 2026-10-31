#!/usr/bin/env node
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    failed += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log(`smoke → ${BASE}`);

  const health = await fetch(`${BASE}/api/health`);
  const hj = await health.json().catch(() => ({}));
  ok("GET /api/health", health.ok && hj.ok === true, JSON.stringify(hj));

  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  ok(
    "GET /",
    home.ok && (html.includes("docx-form") || html.includes("id=\"app\"")),
    `status=${home.status}`,
  );

  const style = await fetch(`${BASE}/style.css`);
  ok("GET /style.css", style.ok, `status=${style.status}`);

  const appJs = await fetch(`${BASE}/app.js`);
  ok("GET /app.js", appJs.ok, `status=${appJs.status}`);

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nAll smoke tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
