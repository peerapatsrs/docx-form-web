#!/usr/bin/env node
/**
 * DEF-BE-UPLOAD-BODY-LIMIT-10MB — real Next server upload size integration.
 *
 * Spawns `next start` (builds first if needed) and posts:
 *  - ~11MB valid .docx → /api/parse|/fill|/template/tag|/batch-fill succeed
 *  - ~26MB body → TOO_LARGE (FILE_TOO_LARGE / BATCH_FILL_TOO_LARGE) on all 4
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  FILE_TOO_LARGE,
  MAX_DOCX_BYTES,
  UPLOAD_TOO_LARGE_STATUS,
} from "../src/lib/upload-limits.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function pickFreePort() {
  if (process.env.UPLOAD_LIMIT_TEST_PORT) {
    return Number(process.env.UPLOAD_LIMIT_TEST_PORT);
  }
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

let PORT = 0;
let BASE = "";
const AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ||
  "upload-limit-integration-secret-32chars!!";

const DOCUMENT_CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="bin" ContentType="application/octet-stream"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// OOXML markup lives under scripts/fixtures/ (excluded from embedded-data scan).
const DOC_XML = readFileSync(
  join(__dirname, "fixtures", "hello-word-document.xml"),
  "utf8",
);

async function buildDocx(targetBytes) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", DOCUMENT_CT);
  zip.folder("_rels").file(".rels", RELS);
  zip.folder("word").file("document.xml", DOC_XML);
  // Uncompressed padding so final ZIP ≈ targetBytes.
  const padSize = Math.max(1024, targetBytes - 8 * 1024);
  zip.folder("word").folder("media").file("pad.bin", Buffer.alloc(padSize, 0x61), {
    compression: "STORE",
  });
  let buf = Buffer.from(
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 1 },
    }),
  );
  // If still short (deflate of zeros is tiny), append STORE-only second pass.
  if (buf.length < targetBytes) {
    const zip2 = new JSZip();
    zip2.file("[Content_Types].xml", DOCUMENT_CT);
    zip2.folder("_rels").file(".rels", RELS);
    zip2.folder("word").file("document.xml", DOC_XML);
    zip2
      .folder("word")
      .folder("media")
      .file("pad.bin", Buffer.alloc(targetBytes, 0x62), { compression: "STORE" });
    buf = Buffer.from(
      await zip2.generateAsync({
        type: "nodebuffer",
        compression: "STORE",
      }),
    );
  }
  // Trim or grow slightly to land near target (ZIP EOCD must stay intact —
  // prefer oversize and accept; assert minimum).
  assert.ok(
    buf.length >= targetBytes * 0.95,
    `docx size ${buf.length} too small vs target ${targetBytes}`,
  );
  return buf;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(timeoutMs = 120_000) {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(`server not healthy: ${lastErr}`);
}

async function runNextBuild() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["next", "build"], {
      cwd: root,
      env: {
        ...process.env,
        BETTER_AUTH_SECRET: AUTH_SECRET,
        NODE_ENV: "production",
      },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function needsRebuild() {
  const buildIdPath = join(root, ".next", "BUILD_ID");
  if (!existsSync(buildIdPath)) return true;
  const buildM = statSync(buildIdPath).mtimeMs;
  for (const rel of [
    "next.config.ts",
    "src/lib/upload-limits.ts",
    "src/server/api.ts",
    "src/proxy.ts",
  ]) {
    const p = join(root, rel);
    if (existsSync(p) && statSync(p).mtimeMs > buildM) return true;
  }
  return false;
}

async function ensureBuild() {
  if (!needsRebuild()) {
    console.log("reusing existing .next build");
    return;
  }
  // Rebuild so api/next.config changes under test are in the server.
  // Next may exit non-zero after a successful compile due to a security nudge;
  // retry once, then accept a present BUILD_ID.
  console.log("building Next app for upload integration…");
  let code = await runNextBuild();
  if (code !== 0) {
    console.log("next build exited non-zero; retrying once…");
    code = await runNextBuild();
  }
  if (!existsSync(join(root, ".next", "BUILD_ID"))) {
    throw new Error(`next build failed (exit ${code}) and no BUILD_ID`);
  }
}

async function startServer() {
  // Run via shell exec so child.pid is the next-server process (not a wrapper).
  const child = spawn(
    "npx next start -H 127.0.0.1 -p " + String(PORT),
    {
      cwd: root,
      env: {
        ...process.env,
        BETTER_AUTH_SECRET: AUTH_SECRET,
        PORT: String(PORT),
        PREMIUM_ENFORCE: "0",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: true,
    },
  );
  let logs = "";
  child.stdout?.on("data", (d) => {
    logs += d.toString();
  });
  child.stderr?.on("data", (d) => {
    logs += d.toString();
  });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error("next start exited:", code, logs.slice(-2000));
    }
  });
  await waitHealth();
  return child;
}

function stopServer(child) {
  if (!child?.pid) return;
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Build a multipart body with a known Content-Length (browsers always send it;
 * Node fetch+FormData often uses chunked encoding without Content-Length).
 */
function buildMultipart(fields) {
  const boundary = `----docxUploadBoundary${Date.now().toString(36)}`;
  const chunks = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val && typeof val === "object" && Buffer.isBuffer(val.buffer)) {
      const filename = val.filename || "upload.bin";
      const type =
        val.type ||
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
      );
      chunks.push(val.buffer);
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(val)}\r\n`,
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: body.length,
  };
}

async function postMultipart(path, fields) {
  const { body, contentType, contentLength } = buildMultipart(fields);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "content-length": String(contentLength),
    },
    body,
  });
  const ct = res.headers.get("content-type") || "";
  let parsed;
  if (ct.includes("application/json")) {
    parsed = await res.json();
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    parsed = { _binary: true, _bytes: buf.length };
  }
  return { status: res.status, body: parsed, contentLength };
}

function fileField(buf, name = "template.docx") {
  return {
    buffer: buf,
    filename: name,
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

console.log("upload-body-limit-integration-test");

PORT = await pickFreePort();
BASE = `http://127.0.0.1:${PORT}`;
console.log(`  using port ${PORT}`);

await ensureBuild();
const server = await startServer();
let failed = 0;

try {
  const mid = await buildDocx(11 * 1024 * 1024);
  assert.ok(mid.length > 10 * 1024 * 1024, `mid size ${mid.length}`);
  assert.ok(mid.length <= MAX_DOCX_BYTES, `mid ${mid.length} over cap`);
  console.log(`  fixture ~11MB actual=${mid.length}`);

  {
    const { status, body } = await postMultipart("/api/parse", {
      file: fileField(mid, "mid.docx"),
    });
    if (!(status === 200 && Array.isArray(body.fields) && body.fields.length)) {
      failed += 1;
      console.error("✗ parse 11MB", status, body);
    } else console.log("✓ /api/parse ~11MB ok");
  }

  {
    const { status, body } = await postMultipart("/api/fill", {
      file: fileField(mid, "mid.docx"),
      values: JSON.stringify({ name: "ทดสอบ" }),
    });
    if (!(status === 200 && body._binary && body._bytes > 1000)) {
      failed += 1;
      console.error("✗ fill 11MB", status, body);
    } else console.log("✓ /api/fill ~11MB ok");
  }

  {
    const { status, body } = await postMultipart("/api/template/tag", {
      file: fileField(mid, "mid.docx"),
      replacements: "[]",
    });
    if (!(status === 200 && typeof body.docxBase64 === "string")) {
      failed += 1;
      console.error("✗ template/tag 11MB", status, body);
    } else console.log("✓ /api/template/tag ~11MB ok");
  }

  {
    const { status, body } = await postMultipart("/api/batch-fill", {
      templates: fileField(mid, "mid.docx"),
      items: JSON.stringify([{ filename: "mid.docx", values: { name: "x" } }]),
    });
    if (!(status === 200 && body.ok === true && body.zipBase64)) {
      failed += 1;
      console.error("✗ batch-fill 11MB", status, body);
    } else console.log("✓ /api/batch-fill ~11MB ok");
  }

  // 26MB — Content-Length pre-check should fire (no need for a real valid package).
  const huge = Buffer.alloc(26 * 1024 * 1024, 0x50);
  // Make it look like PK… so FormData size is huge; Content-Length gate runs first.
  huge[0] = 0x50;
  huge[1] = 0x4b;

  const oversizeRoutes = [
    {
      path: "/api/parse",
      fields: { file: fileField(huge, "huge.docx") },
      code: FILE_TOO_LARGE,
    },
    {
      path: "/api/fill",
      fields: {
        file: fileField(huge, "huge.docx"),
        values: JSON.stringify({ name: "x" }),
      },
      code: FILE_TOO_LARGE,
    },
    {
      path: "/api/template/tag",
      fields: { file: fileField(huge, "huge.docx"), replacements: "[]" },
      code: FILE_TOO_LARGE,
    },
    {
      path: "/api/batch-fill",
      fields: {
        templates: fileField(huge, "huge.docx"),
        items: JSON.stringify([
          { filename: "huge.docx", values: { name: "x" } },
        ]),
      },
      code: "BATCH_FILL_TOO_LARGE",
    },
  ];

  for (const route of oversizeRoutes) {
    const { status, body } = await postMultipart(route.path, route.fields);
    const okCode =
      status === UPLOAD_TOO_LARGE_STATUS && body?.code === route.code;
    if (!okCode) {
      failed += 1;
      console.error(
        `✗ ${route.path} 26MB expected ${UPLOAD_TOO_LARGE_STATUS} ${route.code}`,
        status,
        body,
      );
    } else {
      console.log(`✓ ${route.path} 26MB → ${route.code}`);
    }
  }
} finally {
  stopServer(server);
  await sleep(400);
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

if (failed) {
  console.error(`upload-body-limit-integration-test: ${failed} failed`);
  process.exit(1);
}
console.log("upload-body-limit-integration-test: ok");
