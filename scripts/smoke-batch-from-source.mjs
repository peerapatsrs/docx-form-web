#!/usr/bin/env node
/**
 * Smoke: one real POST /api/batch-from-source against BASE_URL with a fixture doc.
 * Prints status + duration. Uses shared env Cursor key path when no user key is sent.
 *
 *   BASE_URL=http://127.0.0.1:3000 node scripts/smoke-batch-from-source.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const fixture = join(__dirname, "..", "public", "examples", "sample-quote.docx");

async function jarFetch(path, { method = "GET", headers = {}, body, jar } = {}) {
  /** @type {Record<string, string>} */
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
  return { res, text, json, jar };
}

console.log(`smoke-batch-from-source → ${BASE}`);

const health = await fetch(`${BASE}/api/health`);
if (!health.ok) {
  console.error(`health failed: ${health.status}`);
  process.exit(1);
}
console.log("✓ health");

const jar = { cookie: "" };
const login = await jarFetch("/api/auth/dev/login-as", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "qa@example.com" }),
  jar,
});
console.log(
  `login-as status=${login.res.status}${login.res.ok || login.res.status === 302 ? " ✓" : ""}`,
);

const status = await jarFetch("/api/ai/status", { jar });
const st = status.json || {};
console.log(
  `ai/status effective=${st.effectiveProvider || st.provider} model=${st.model} timeoutMs=${st.aiTimeoutMs} connected=${st.connected}`,
);
console.log(
  `pill: พร้อมใช้ · ${st.effectiveProviderLabel || st.providerLabel || st.effectiveProvider || "?"} · ${st.model || "?"}`,
);

const buf = readFileSync(fixture);
const fd = new FormData();
fd.append(
  "schemas",
  JSON.stringify([
    {
      id: "quote1",
      filename: "sample-quote.docx",
      fields: [
        { name: "ชื่อ", type: "text" },
        { name: "วันที่", type: "text" },
      ],
      valuesJson: {
        format: "docx-form-values",
        version: 1,
        template: "sample-quote.docx",
        fields: [
          { name: "ชื่อ", type: "text" },
          { name: "วันที่", type: "text" },
        ],
        values: { ชื่อ: "", วันที่: "" },
        skip: {},
      },
    },
  ]),
);
fd.append(
  "files",
  new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }),
  "sample-quote.docx",
);
// Env-key path only: do not send X-Ai-Key-Id / plaintext key.
fd.append("aiProvider", String(st.effectiveProvider || "cursor"));
fd.append("aiModel", String(st.model || "composer-2.5"));

const t0 = Date.now();
const batch = await jarFetch("/api/batch-from-source", {
  method: "POST",
  body: fd,
  jar,
});
const durationMs = Date.now() - t0;

console.log(
  JSON.stringify(
    {
      status: batch.res.status,
      durationMs,
      code: batch.json?.code || null,
      error: batch.json?.error ? String(batch.json.error).slice(0, 240) : null,
      ok: batch.json?.ok ?? null,
      mapped: batch.json?.mapped ?? null,
      total: batch.json?.total ?? null,
    },
    null,
    2,
  ),
);

if (batch.res.status >= 500 && !batch.json?.code) {
  console.error("unexpected 5xx without code");
  process.exit(1);
}

console.log("smoke-batch-from-source: done");
