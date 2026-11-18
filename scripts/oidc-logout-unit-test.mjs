#!/usr/bin/env node
/**
 * RP-initiated logout: CSP form-action, HTML continue for cross-origin
 * end_session, session-index idToken persistence, AuthBar top-level POST.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${name}`);
      console.error(err);
    }
  })();
}

console.log("oidc-logout-unit-test");

await check("AuthBar logout is top-level form POST (not fetch)", async () => {
  const bar = readFileSync(join(root, "src/components/AuthBar.tsx"), "utf8");
  assert.match(bar, /method=["']POST["']/);
  assert.match(bar, /action=\{SSO_LOGOUT_PATH\}|action=["']\/api\/auth\/oidc\/logout["']/);
  assert.doesNotMatch(bar, /fetch\s*\(\s*['"`]\/api\/auth\/oidc\/logout/);
  assert.doesNotMatch(bar, /window\.location\.assign\s*\(\s*SSO_LOGOUT_PATH/);
});

await check("account logout is top-level form POST", async () => {
  const account = readFileSync(join(root, "src/app/account/page.tsx"), "utf8");
  assert.match(account, /method\s*=\s*["']POST["']/);
  assert.match(account, /\/api\/auth\/oidc\/logout/);
  assert.doesNotMatch(account, /fetch\s*\(\s*['"`]\/api\/auth\/oidc\/logout/);
});

await check("session index persists idToken for RP logout hint", async () => {
  const stores = readFileSync(join(root, "src/server/mw-auth-stores.ts"), "utf8");
  assert.match(stores, /ADD COLUMN IF NOT EXISTS "idToken"/);
  assert.match(stores, /"idToken"/);
  assert.match(stores, /session\.idToken/);
});

await check("logout route converts cross-origin end_session to HTML continue", async () => {
  process.env.APP_BASE_URL = "https://docx-form-dev.tps18.space";
  const id = `../src/server/mw-auth-route.ts?t=${Date.now()}-${Math.random()}`;
  const {
    buildEndSessionContinueHtml,
    maybeContinueToEndSession,
    escapeHtmlAttr,
  } = await import(id);

  const endSession =
    "https://auth.tps18.space/realms/tps18-dev/protocol/openid-connect/logout?client_id=docx&post_logout_redirect_uri=https%3A%2F%2Fdocx-form-dev.tps18.space%2Flogged-out&id_token_hint=abc.def.ghi";
  const html = buildEndSessionContinueHtml(endSession);
  assert.match(html, /meta http-equiv="refresh"/);
  assert.match(html, /oidc-end-session-continue/);
  assert.match(html, /location\.replace\(a\.href\)/);
  assert.match(html, /auth\.tps18\.space/);
  // URL must not be embedded as a JS string literal in <script>.
  assert.doesNotMatch(html, /<script>[\s\S]*https:\/\/auth\.tps18\.space/);
  assert.equal(escapeHtmlAttr(`a&b"c`), "a&amp;b&quot;c");

  // DEF-BE-END-SESSION-CONTINUE-SCRIPT-BREAKOUT (QA repro)
  const breakout =
    "https://auth.tps18.space/x?</script><script>alert(1)</script>";
  const breakoutHtml = buildEndSessionContinueHtml(breakout);
  assert.match(breakoutHtml, /meta http-equiv="refresh"/);
  assert.match(
    breakoutHtml,
    /href="https:\/\/auth\.tps18\.space\/x\?&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/,
  );
  assert.match(
    breakoutHtml,
    /content="0;url=https:\/\/auth\.tps18\.space\/x\?&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/,
  );
  // Unescaped </script><script>alert must not appear (would close/open scripts).
  assert.doesNotMatch(
    breakoutHtml,
    /<\/script>\s*<script>\s*alert\s*\(\s*1\s*\)/i,
  );
  for (const m of breakoutHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotMatch(m[1], /alert\s*\(/i);
    assert.doesNotMatch(m[1], /https?:\/\//i);
    assert.doesNotMatch(m[1], /<\/script>/i);
  }

  const redirect = new Response(null, {
    status: 303,
    headers: {
      Location: endSession,
      "Set-Cookie": "mw_session=; Max-Age=0; Path=/",
    },
  });
  const continued = maybeContinueToEndSession(redirect);
  assert.equal(continued.status, 200);
  assert.match(continued.headers.get("content-type") || "", /text\/html/);
  assert.equal(continued.headers.get("location"), null);
  const body = await continued.text();
  assert.match(body, /openid-connect\/logout/);
  assert.match(body, /id_token_hint/);
  const cookies = continued.headers.getSetCookie?.() || [];
  assert.ok(cookies.some((c) => /mw_session=/.test(c) && /Max-Age=0/i.test(c)));

  // Same-origin post_logout fallback stays a redirect (no HTML bounce).
  const local = new Response(null, {
    status: 303,
    headers: { Location: "https://docx-form-dev.tps18.space/logged-out" },
  });
  const kept = maybeContinueToEndSession(local);
  assert.equal(kept.status, 303);
  assert.equal(
    kept.headers.get("location"),
    "https://docx-form-dev.tps18.space/logged-out",
  );
});

await check("mw-shared logout loads idToken from session store", async () => {
  const clientSrc = readFileSync(
    join(root, "vendor/mw-shared/auth/src/core/client.ts"),
    "utf8",
  );
  assert.match(clientSrc, /sessions\.get\(input\.sessionId\)/);
  assert.match(clientSrc, /sessionIdToken/);
  assert.match(clientSrc, /existing\?\.idToken/);
});

await check("next.config omits CSP; proxy applies runtime CSP", async () => {
  const nextCfg = readFileSync(join(root, "next.config.ts"), "utf8");
  assert.match(nextCfg, /staticSecurityHeaders/);
  assert.doesNotMatch(nextCfg, /securityHeaders\(\)/);
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  assert.match(proxy, /securityHeaders/);
});

restoreEnv();

if (failed) {
  console.error(`\n${failed} oidc-logout unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-logout unit tests passed");
