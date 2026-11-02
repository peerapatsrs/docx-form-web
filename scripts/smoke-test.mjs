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
  ok(
    "GET /api/health",
    health.ok && hj.ok === true && hj.version === undefined,
    JSON.stringify(hj),
  );

  const me = await fetch(`${BASE}/api/me`);
  const mej = await me.json().catch(() => ({}));
  ok(
    "GET /api/me guest",
    me.ok && me.status === 200 && mej.user === null,
    JSON.stringify(mej),
  );

  const robots = await fetch(`${BASE}/robots.txt`);
  const robotsText = await robots.text();
  ok(
    "GET /robots.txt",
    robots.ok && /sitemap/i.test(robotsText),
    `status=${robots.status}`,
  );

  const sitemap = await fetch(`${BASE}/sitemap.xml`);
  ok("GET /sitemap.xml", sitemap.ok, `status=${sitemap.status}`);

  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  ok(
    "GET /",
    home.ok && (html.includes("docx-form") || html.includes("id=\"app\"")),
    `status=${home.status}`,
  );
  ok(
    "security headers",
    Boolean(
      home.headers.get("content-security-policy") &&
        home.headers.get("strict-transport-security") &&
        home.headers.get("x-frame-options") &&
        home.headers.get("x-content-type-options") &&
        home.headers.get("referrer-policy") &&
        home.headers.get("permissions-policy") &&
        !home.headers.get("x-powered-by"),
    ),
    `csp=${home.headers.get("content-security-policy") ? "yes" : "no"} powered=${home.headers.get("x-powered-by")}`,
  );

  const style = await fetch(`${BASE}/style.css`);
  ok("GET /style.css", style.ok, `status=${style.status}`);

  const fieldNames = await fetch(`${BASE}/field-names.js`);
  ok("GET /field-names.js", fieldNames.ok, `status=${fieldNames.status}`);
  const fieldNamesBody = await fieldNames.text();
  ok(
    "field-names.js exposes DocxFieldNames",
    /DocxFieldNames\s*=/.test(fieldNamesBody),
  );

  const appJs = await fetch(`${BASE}/app.js`);
  ok("GET /app.js", appJs.ok, `status=${appJs.status}`);
  const appBody = await appJs.text();
  ok(
    "app.js requires field-names.js",
    /field-names\.js is not loaded/.test(appBody) &&
      /docxFieldNames\(/.test(appBody),
  );

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
