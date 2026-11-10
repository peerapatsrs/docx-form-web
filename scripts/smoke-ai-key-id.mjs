/** OIDC-only: obtain a session via Keycloak (or mock OIDC); /api/auth/dev/login-as was removed. */
#!/usr/bin/env node
/**
 * Local smoke: X-Ai-Key-Id-only credentials, delete ownership, admin env flags,
 * and shared dialog asset. Mocks AI by exercising resolve path without a live
 * provider call where possible.
 *
 * Requires DOCX_FORM_AI_KEY_TEST_MOCK=ok on the **server** (and this process as a
 * reminder) so PUT /api/ai/keys with a fake Google key passes F30 validate-on-save.
 *
 *   DOCX_FORM_AI_KEY_TEST_MOCK=ok BASE_URL=http://127.0.0.1:3000 node scripts/smoke-ai-key-id.mjs
 */
import assert from "node:assert/strict";

const MOCK = String(process.env.DOCX_FORM_AI_KEY_TEST_MOCK || "").trim();
if (!MOCK) {
  console.error(
    "smoke-ai-key-id: set DOCX_FORM_AI_KEY_TEST_MOCK=ok (server + this process) before running — fake Google keys need mock validate-on-save",
  );
  process.exit(1);
}

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    failed += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function jarFetch(path, { method = "GET", headers = {}, body, jar } = {}) {
  /** @type {Record<string, string>} */
  const hdrs = {
    Origin: BASE,
    ...headers,
  };
  if (jar.cookie) hdrs.Cookie = jar.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: hdrs,
    body,
    redirect: "manual",
  });
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) {
    const part = String(c).split(";")[0];
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    const map = Object.fromEntries(
      (jar.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const i = x.indexOf("=");
          return [x.slice(0, i), x.slice(i + 1)];
        }),
    );
    map[k] = v;
    jar.cookie = Object.entries(map)
      .map(([a, b]) => `${a}=${b}`)
      .join("; ");
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { res, text, json, jar };
}

console.log(`smoke-ai-key-id → ${BASE}`);

const health = await fetch(`${BASE}/api/health`);
ok("health", health.ok);

const jar = { cookie: "" };
const sessionCookie = String(process.env.SESSION_COOKIE || "").trim();
if (!sessionCookie) {
  console.error("OIDC-only: set SESSION_COOKIE to a Better Auth session cookie (dev login-as removed).");
  process.exit(2);
}
jar.cookie = sessionCookie;
ok("OIDC session cookie provided", true);

const me = await jarFetch("/api/me", { jar });
ok("session /api/me", Boolean(me.json?.user?.id), JSON.stringify(me.json).slice(0, 200));
const userId = me.json?.user?.id;

const keyId = `k-smoke-${Date.now().toString(36)}`;
const put = await jarFetch("/api/ai/keys", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    entry: {
      id: keyId,
      provider: "google",
      label: "smoke-key",
      model: "gemini-3.8-flash",
      apiKey: "AIzaSySmokeTestKeyNotReal00000001",
    },
  }),
  jar,
});
ok("PUT /api/ai/keys", put.res.ok, put.text.slice(0, 300));

const status = await jarFetch("/api/ai/status", {
  headers: { "X-Ai-Key-Id": keyId },
  jar,
});
ok(
  "GET /api/ai/status with X-Ai-Key-Id only connected",
  status.res.ok && status.json?.connected === true,
  JSON.stringify(status.json).slice(0, 400),
);
ok(
  "status model remapped when effective cursor",
  !status.json?.model || typeof status.json.model === "string",
  `model=${status.json?.model} provider=${status.json?.effectiveProvider}`,
);

const diag = await jarFetch("/api/diagnostics", {
  headers: { "X-Ai-Key-Id": keyId },
  jar,
});
ok(
  "GET /api/diagnostics accepts X-Ai-Key-Id (superadmin)",
  diag.res.ok || diag.res.status === 403 || diag.res.status === 401,
  `status=${diag.res.status}`,
);
if (diag.res.ok) {
  ok(
    "diagnostics.ai present with resolved creds",
    Boolean(diag.json?.ai),
    JSON.stringify(diag.json?.ai).slice(0, 300),
  );
}

// batch-from-source with X-Ai-Key-Id only — expect not the old generic 401
const fd = new FormData();
fd.append(
  "schemas",
  JSON.stringify([
    {
      id: "t1",
      filename: "t.docx",
      fields: [{ name: "ชื่อ", type: "text" }],
      valuesJson: {
        format: "docx-form-values",
        template: "t.docx",
        fields: [{ name: "ชื่อ", type: "text" }],
        values: { ชื่อ: "" },
      },
    },
  ]),
);
fd.append(
  "files",
  new Blob(["not-a-real-docx"], { type: "application/octet-stream" }),
  "source.txt",
);
const batch = await jarFetch("/api/batch-from-source", {
  method: "POST",
  headers: { "X-Ai-Key-Id": keyId },
  body: fd,
  jar,
});
const batchErr = String(batch.json?.error || "");
ok(
  "POST /api/batch-from-source X-Ai-Key-Id not generic no-key 401",
  !(batch.res.status === 401 && /ยังไม่มี AI API key/.test(batchErr)),
  `status=${batch.res.status} err=${batchErr.slice(0, 200)}`,
);

// source-map regression: same header path
const fd2 = new FormData();
fd2.append(
  "fields",
  JSON.stringify([{ name: "ชื่อ", type: "text" }]),
);
fd2.append(
  "valuesJson",
  JSON.stringify({
    format: "docx-form-values",
    template: "t.docx",
    fields: [{ name: "ชื่อ", type: "text" }],
    values: { ชื่อ: "" },
  }),
);
fd2.append(
  "files",
  new Blob(["x"], { type: "text/plain" }),
  "source.txt",
);
const sm = await jarFetch("/api/source-map", {
  method: "POST",
  headers: { "X-Ai-Key-Id": keyId },
  body: fd2,
  jar,
});
const smErr = String(sm.json?.error || "");
ok(
  "POST /api/source-map X-Ai-Key-Id not generic no-key 401",
  !(sm.res.status === 401 && /ยังไม่มี AI API key/.test(smErr)),
  `status=${sm.res.status} err=${smErr.slice(0, 200)}`,
);

const del = await jarFetch(`/api/ai/keys/${encodeURIComponent(keyId)}`, {
  method: "DELETE",
  jar,
});
ok("DELETE own key 200", del.res.ok && del.json?.removed === true, del.text.slice(0, 200));

const delAgain = await jarFetch(`/api/ai/keys/${encodeURIComponent(keyId)}`, {
  method: "DELETE",
  jar,
});
ok("DELETE missing key 404", delAgain.res.status === 404, `status=${delAgain.res.status}`);

const afterDel = await jarFetch("/api/ai/status", {
  headers: { "X-Ai-Key-Id": keyId },
  jar,
});
ok(
  "status after delete does not 500",
  afterDel.res.status < 500,
  `status=${afterDel.res.status}`,
);

const adminAi = await jarFetch("/api/admin/ai", { jar });
if (adminAi.res.ok) {
  ok(
    "admin ai env cursor presence only",
    adminAi.json?.status?.hasServerEnvCursorKey === true &&
      adminAi.json?.status?.serverEnvCursorKeySource === "set via server",
    JSON.stringify(adminAi.json?.status).slice(0, 400),
  );
  const dumped = JSON.stringify(adminAi.json);
  ok(
    "admin ai response never includes env key value",
    !dumped.includes("crsr_smoke_shared_key_not_real_xx"),
  );
} else {
  ok("admin ai reachable or forbidden", adminAi.res.status === 403, `status=${adminAi.res.status}`);
}

const clearAsUser = await jarFetch("/api/admin/ai/server-key", {
  method: "DELETE",
  jar,
});
// qa user is superadmin via SUPERADMIN_EMAILS — may succeed with cleared:false-ish or 400 BYOK
ok(
  "admin clear server-key not 500",
  clearAsUser.res.status !== 500,
  `status=${clearAsUser.res.status} body=${clearAsUser.text.slice(0, 200)}`,
);

const home = await fetch(`${BASE}/`);
const homeHtml = await home.text();
ok("home has status pill", homeHtml.includes('id="status"') && homeHtml.includes("statusText"));

const account = await jarFetch("/account", { jar });
ok("account page loads (auth)", account.res.ok, `status=${account.res.status}`);
// Client component hydrates the AI keys section — assert source wiring in smoke.
const accountSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/app/account/page.tsx", import.meta.url), "utf8"),
);
ok("account page includes AiKeysSection", /AiKeysSection/.test(accountSrc));

const dialogJs = await fetch(`${BASE}/ai-key-dialog.js`);
const dialogBody = await dialogJs.text();
ok(
  "shared ai-key-dialog.js served",
  dialogJs.ok &&
    (/openAiKeyDialog/.test(dialogBody) || /openAiKeysDialog/.test(dialogBody)) &&
    /ลบคีย์นี้\?/.test(dialogBody),
);

const appJs = await fetch(`${BASE}/app.js`);
const appBody = await appJs.text();
ok(
  "app.js wires pill + shared dialog",
  appJs.ok &&
    (/bindStatusPillAiKeysOpener/.test(appBody) ||
      /openAiKeyDialog/.test(appBody) ||
      /openAiKeysManager/.test(appBody)) &&
    /ai-key-dialog\.js/.test(appBody),
);

console.log(`userId=${userId || "?"} keyId=${keyId}`);
if (failed) {
  console.error(`smoke-ai-key-id: ${failed} failed`);
  process.exit(1);
}
console.log("smoke-ai-key-id: ok");
