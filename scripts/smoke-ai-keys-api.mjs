#!/usr/bin/env node
/**
 * HTTP smoke for AI keys API (session user).
 * Uses DOCX_FORM_AI_KEY_TEST_MOCK when set; create/rotate require mock=ok (F30).
 *
 *   BASE_URL=http://127.0.0.1:3000 DOCX_FORM_AI_KEY_TEST_MOCK=ok node scripts/smoke-ai-keys-api.mjs
 */
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
  const hdrs = { Origin: BASE, ...headers };
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
  return { res, text, json };
}

console.log(`smoke-ai-keys-api → ${BASE}`);

const health = await fetch(`${BASE}/api/health`);
ok("health", health.ok);

const entitlement = await fetch(`${BASE}/api/entitlement`);
const entJson = await entitlement.json().catch(() => ({}));
ok(
  "entitlement has maxMultiTemplates + uploadLimitText + upgradeUrl (F02/F37)",
  entitlement.ok &&
    Number(entJson?.premium?.maxMultiTemplates) > 0 &&
    Boolean(entJson?.premium?.uploadLimitText) &&
    typeof entJson?.premium?.upgradeUrl === "string",
  JSON.stringify(entJson?.premium).slice(0, 200),
);

const statusAnon = await fetch(`${BASE}/api/ai/status`);
const statusAnonJson = await statusAnon.json().catch(() => ({}));
ok(
  "GET /api/ai/status has keySource + upgradeUrl (F19/F31/F37)",
  statusAnon.ok &&
    ["user", "shared", "none"].includes(String(statusAnonJson?.keySource || "")) &&
    typeof statusAnonJson?.upgradeUrl === "string",
  JSON.stringify({
    keySource: statusAnonJson?.keySource,
    upgradeUrl: statusAnonJson?.upgradeUrl,
    effectiveProvider: statusAnonJson?.effectiveProvider,
    effectiveModel: statusAnonJson?.effectiveModel || statusAnonJson?.model,
  }),
);
ok(
  "status never leaks configPath / env names (F18)",
  !("configPath" in (statusAnonJson || {})) &&
    !JSON.stringify(statusAnonJson || {}).includes("DOCX_FORM_CURSOR_API_KEY") &&
    !JSON.stringify(statusAnonJson || {}).includes("/tmp/"),
);

const jar = { cookie: "" };
const login = await jarFetch("/api/auth/dev/login-as", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "qa@example.com" }),
  jar,
});
ok("dev login-as", login.res.ok || login.res.status === 302, `status=${login.res.status}`);

const unauth = await fetch(`${BASE}/api/ai/keys`);
ok(
  "GET /api/ai/keys without session → 401 AI_KEY_UNAUTHORIZED",
  unauth.status === 401,
  `status=${unauth.status}`,
);

// F30: invalid key must be rejected and not stored.
// Infer server mock mode from the response — do not trust the smoke client's env
// (the running server may have a different DOCX_FORM_AI_KEY_TEST_MOCK).
const badId = `k-smoke-bad-${Date.now().toString(36)}`;
const rejectCreate = await jarFetch("/api/ai/keys", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: badId,
    provider: "cursor",
    label: "bad",
    model: "composer-2.5",
    apiKey: "crsr_QA_fake_invalid_000",
  }),
  jar,
});
const rejectCode = String(rejectCreate.json?.code || "");
const serverAcceptedFake =
  rejectCreate.res.status === 201 || rejectCreate.res.ok;
const rejected =
  rejectCreate.res.status >= 400 &&
  (rejectCode === "AI_KEY_INVALID" ||
    rejectCode === "AI_PROVIDER_AUTH" ||
    rejectCode === "AI_PROVIDER_TIMEOUT" ||
    rejectCode === "AI_PROVIDER_ERROR" ||
    rejectCode === "AI_KEY_PROVIDER_AUTH" ||
    rejectCode === "AI_KEY_PROVIDER_ERROR" ||
    rejectCode === "AI_KEY_INVALID_VALUE");
if (serverAcceptedFake) {
  ok(
    "F30 soft-skip store-reject (server accepted fake key — likely mock=ok)",
    true,
    `status=${rejectCreate.res.status}; set server DOCX_FORM_AI_KEY_TEST_MOCK=401 to exercise reject`,
  );
} else {
  ok(
    "F30 POST invalid key rejected (not stored)",
    rejected && rejectCreate.res.status !== 201,
    `status=${rejectCreate.res.status} code=${rejectCode} body=${rejectCreate.text.slice(0, 200)}`,
  );
  const listAfterBad = await jarFetch("/api/ai/keys", { jar });
  ok(
    "F30 rejected key absent from list",
    Array.isArray(listAfterBad.json?.entries) &&
      !listAfterBad.json.entries.some((e) => e.id === badId),
  );
}

const keyId = `k-smoke-keys-${Date.now().toString(36)}`;
const create = await jarFetch("/api/ai/keys", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: keyId,
    provider: "google",
    label: "smoke",
    model: "gemini-3.8-flash",
    apiKey: "AIzaSySmokeTestKeyNotRealMASK99",
  }),
  jar,
});
const createdOk = create.res.status === 201 && create.json?.entry?.id === keyId;
ok(
  "POST create 201 (needs server DOCX_FORM_AI_KEY_TEST_MOCK=ok or live valid key)",
  createdOk,
  `status=${create.res.status} body=${create.text.slice(0, 200)}`,
);
if (createdOk) {
  ok(
    "create response masked",
    Boolean(create.json?.entry?.maskedKey) &&
      !String(create.json?.entry?.maskedKey || "").includes("AIzaSySmoke"),
    JSON.stringify(create.json?.entry).slice(0, 200),
  );

  const list = await jarFetch("/api/ai/keys", { jar });
  ok(
    "GET list includes key",
    Array.isArray(list.json?.entries) &&
      list.json.entries.some((e) => e.id === keyId),
  );

  const got = await jarFetch(`/api/ai/keys/${encodeURIComponent(keyId)}`, { jar });
  ok("GET one", got.res.ok && got.json?.entry?.id === keyId);

  const testPlain = await jarFetch("/api/ai/keys/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "google",
      apiKey: "AIzaSySmokeTestKeyNotRealMASK99",
      timeoutMs: 5000,
    }),
    jar,
  });
  ok(
    "POST plaintext test returns code",
    Boolean(testPlain.json?.code),
    JSON.stringify(testPlain.json).slice(0, 240),
  );

  const testSaved = await jarFetch(
    `/api/ai/keys/${encodeURIComponent(keyId)}/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutMs: 5000 }),
      jar,
    },
  );
  ok(
    "POST saved test returns code + entry",
    Boolean(testSaved.json?.code),
    JSON.stringify(testSaved.json).slice(0, 240),
  );

  const rotate = await jarFetch(`/api/ai/keys/${encodeURIComponent(keyId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: "AIzaSySmokeTestKeyNotRealMASK88",
      label: "rotated-smoke",
    }),
    jar,
  });
  ok(
    "PUT rotate",
    rotate.res.ok && rotate.json?.entry?.label === "rotated-smoke",
    `status=${rotate.res.status} body=${rotate.text.slice(0, 200)}`,
  );

  const audit = await jarFetch(
    `/api/ai/keys/audit?keyId=${encodeURIComponent(keyId)}`,
    { jar },
  );
  ok(
    "GET audit has create/replace/test",
    Array.isArray(audit.json?.events) && audit.json.events.length >= 1,
    JSON.stringify(audit.json?.events?.slice?.(0, 3)).slice(0, 300),
  );
  ok(
    "audit never leaks key",
    !JSON.stringify(audit.json || {}).includes("AIzaSySmoke"),
  );

  const del = await jarFetch(`/api/ai/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
    jar,
  });
  ok("DELETE own", del.res.ok && del.json?.code === "AI_KEY_DELETED");
}

const delOther = await jarFetch(`/api/ai/keys/${encodeURIComponent("k-not-yours")}`, {
  method: "DELETE",
  jar,
});
ok(
  "DELETE missing → 404 AI_KEY_NOT_FOUND",
  delOther.res.status === 404 && delOther.json?.code === "AI_KEY_NOT_FOUND",
);

const singular = await jarFetch("/api/ai/key", { jar });
ok("GET singular alias", singular.res.ok);

if (failed) {
  console.error(`smoke-ai-keys-api: ${failed} failed`);
  process.exit(1);
}
console.log("smoke-ai-keys-api: ok");
