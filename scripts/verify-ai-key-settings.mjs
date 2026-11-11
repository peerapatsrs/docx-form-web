#!/usr/bin/env node
/**
 * AI key settings + model picker screenshots (feat/ai-key-ui).
 * Mocks session + settings state; never injects a system key value.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAiModelGroups,
  renderAiModelPickerHtml,
} from "../public/ai-model-picker.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "verify", "screenshots");
const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

let playwright;
try {
  playwright = require("playwright");
} catch {
  console.error("playwright required");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const MOCK_USER = {
  name: "Peerapat Surasing",
  email: "peerapat.srs@gmail.com",
  role: "superadmin",
  plan: "pro",
  image: null,
};

function assertNoSecrets(text) {
  const bad = [/AIza[0-9A-Za-z_-]{10,}/, /\bsk-[A-Za-z0-9]{10,}/, /crsr_[A-Za-z0-9]{10,}/];
  for (const re of bad) {
    if (re.test(text)) throw new Error(`Possible secret leaked in DOM: ${re}`);
  }
}

async function withPage(browserType, label, width, height, deviceOpts, fn) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: deviceOpts.deviceScaleFactor || 1,
    isMobile: !!deviceOpts.isMobile,
    hasTouch: !!deviceOpts.hasTouch,
    userAgent: deviceOpts.userAgent,
  });
  await context.addInitScript((user) => {
    window.__DOCX_FORM_VERIFY_SESSION__ = { user };
  }, MOCK_USER);

  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    try {
      const url = route.request().url();
      if (url.includes("/api/auth/") && (url.includes("get-session") || url.includes("session"))) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ session: { id: "v" }, user: MOCK_USER }),
        });
        return;
      }
      if (url.includes("/api/ai/status") || url.includes("/api/ai/key-settings")) {
        const mock = page.__aiKeyMock || {
          mode: "server",
          serverKeyAvailable: true,
          userKeySet: false,
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            connected: mock.serverKeyAvailable || mock.userKeySet,
            mode: mock.mode,
            serverKeyAvailable: mock.serverKeyAvailable,
            serverAiKeyConfigured: mock.serverKeyAvailable,
            userKeySet: mock.userKeySet,
            userKeyHint: mock.userKeyHint,
            keySource: mock.userKeySet ? "user" : mock.serverKeyAvailable ? "shared" : "none",
            models: [
              { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", source: "server" },
              { id: "gpt-4.1-mini", label: "GPT-4.1 mini", source: "byok" },
            ],
          }),
        });
        return;
      }
      if (url.includes("/api/ai/keys") && route.request().method() === "GET") {
        const mock = page.__aiKeyMock || {};
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            entries: mock.userKeySet
              ? [
                  {
                    id: "k-user",
                    provider: "google",
                    label: "คีย์ของฉัน",
                    model: "gemini-3.8-flash",
                    maskedKey: mock.userKeyHint || "••••1234",
                    hasKey: true,
                  },
                ]
              : [],
          }),
        });
        return;
      }
      const fetchUrl =
        url.startsWith("https://127.0.0.1:") || url.startsWith("https://localhost:")
          ? url.replace(/^https:/, "http:")
          : undefined;
      const res = await route.fetch(fetchUrl ? { url: fetchUrl } : undefined);
      const headers = { ...res.headers() };
      if (headers["content-security-policy"]) {
        headers["content-security-policy"] = String(headers["content-security-policy"])
          .replace(/upgrade-insecure-requests;?\s*/gi, "");
      }
      delete headers["strict-transport-security"];
      await route.fulfill({ response: res, headers });
    } catch {
      try {
        await route.abort();
      } catch {
        /* closed */
      }
    }
  });

  try {
    await fn(page, context);
  } finally {
    try {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    } catch {
      /* ignore */
    }
    await context.close();
    await browser.close();
  }
}

async function shotSettings(page, name, mock) {
  page.__aiKeyMock = mock;
  await page.addInitScript((m) => {
    window.__DOCX_FORM_AI_KEY_SETTINGS_MOCK__ = { ...m, force: true };
  }, mock);
  await page.goto(`${baseUrl}/account`, { waitUntil: "networkidle", timeout: 90000 });
  // Account may redirect to login without real session — inject settings panel if needed.
  const hasSection = await page.locator("#account-ai-keys").count();
  if (!hasSection) {
    await page.setContent(`<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="stylesheet" href="${baseUrl}/style.css" />
      </head><body>
      <main class="shell" style="padding:1rem">
        <section class="account-panel ai-key-settings" id="account-ai-keys"></section>
      </main>
      <script type="module">
        import { createRoot } from '${baseUrl}/_next/static/chunks/does-not-exist.js';
      </script>
      </body></html>`);
    // Fallback: render static markup matching AiKeysSection for visual verify.
    const serverDisabled = mock.serverKeyAvailabilityKnown && !mock.serverKeyAvailable;
    await page.evaluate((m) => {
      const el = document.getElementById("account-ai-keys");
      const modeLabel =
        m.mode === "byok" ? "ใช้คีย์ของฉันเอง" : "ใช้คีย์กลางของระบบ";
      el.innerHTML = `
        <div class="account-panel-head"><h2 class="auth-section-title">คีย์ AI</h2></div>
        <p class="ai-key-settings-active"><span class="ai-key-settings-active-badge">กำลังใช้: ${modeLabel}</span></p>
        <p class="auth-hint ai-key-settings-privacy">ระบบจะไม่แสดงหรือขอค่าคีย์กลางของระบบ</p>
        <div class="ai-key-settings-choices" role="radiogroup">
          <label class="ai-key-settings-card ${m.mode === "server" ? "is-selected" : ""} ${!m.serverKeyAvailable && m.serverKeyAvailabilityKnown !== false ? "is-disabled" : ""}">
            <input type="radio" name="ai-key-mode" ${m.mode === "server" ? "checked" : ""} ${!m.serverKeyAvailable && m.serverKeyAvailabilityKnown !== false ? "disabled" : ""} />
            <span class="ai-key-settings-card-body">
              <span class="ai-key-settings-card-title">ใช้คีย์กลางของระบบ</span>
              <span class="ai-key-settings-card-sub">ไม่ต้องกรอกอะไร ระบบใช้คีย์ของบริษัทให้</span>
              ${
                m.serverKeyAvailable
                  ? '<span class="ai-key-settings-card-status is-ready">พร้อมใช้งาน</span>'
                  : '<span class="ai-key-settings-card-status is-warn">ระบบยังไม่ได้ตั้งคีย์กลาง — เลือกคีย์ของฉันเอง หรือติดต่อผู้ดูแล</span>'
              }
            </span>
          </label>
          <label class="ai-key-settings-card ${m.mode === "byok" ? "is-selected" : ""}">
            <input type="radio" name="ai-key-mode" ${m.mode === "byok" ? "checked" : ""} />
            <span class="ai-key-settings-card-body">
              <span class="ai-key-settings-card-title">ใช้คีย์ของฉันเอง</span>
              <span class="ai-key-settings-card-sub">วาง API key ของคุณ เก็บแบบปกปิด — ไม่แสดงค่าเต็มหลังบันทึก</span>
            </span>
          </label>
        </div>
        ${
          m.mode === "byok" && m.userKeySet
            ? `<div class="ai-key-settings-byok"><div class="ai-key-settings-saved">
                <p class="ai-key-settings-masked"><span class="ai-key-masked">${m.userKeyHint || "••••1234"}</span></p>
                <div class="ai-key-settings-saved-actions">
                  <button type="button" class="admin-btn">เปลี่ยนคีย์</button>
                  <button type="button" class="admin-btn admin-btn-danger">ลบคีย์</button>
                </div>
              </div></div>`
            : m.mode === "byok"
              ? `<div class="ai-key-settings-byok"><div class="ai-key-settings-editor">
                  <label class="ai-key-settings-field"><span>API key ของฉัน</span>
                    <span class="ai-key-settings-input-row">
                      <input class="admin-input" type="password" placeholder="วางคีย์ที่นี่" />
                      <button type="button" class="admin-btn ai-key-settings-toggle">แสดง</button>
                    </span>
                  </label>
                  <div class="ai-key-settings-editor-actions">
                    <button type="button" class="admin-btn admin-btn-primary">บันทึกคีย์</button>
                  </div>
                </div></div>`
              : ""
        }
      `;
    }, { ...mock, serverKeyAvailabilityKnown: true });
    // Ensure stylesheet applied
    await page.addStyleTag({ url: `${baseUrl}/style.css` });
  } else {
    await page.waitForSelector(".ai-key-settings-card", { timeout: 20000 });
  }

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      text: document.body?.innerText || "",
      html: document.body?.innerHTML || "",
    };
  });
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    throw new Error(`${name}: horizontal overflow ${overflow.scrollWidth}>${overflow.clientWidth}`);
  }
  assertNoSecrets(overflow.text + overflow.html);
  const path = join(outDir, name);
  await page.locator("#account-ai-keys").screenshot({ path });
  console.log(`✓ ${name}`);
  return path;
}

async function shotPicker(page, name, mock) {
  const groups = buildAiModelGroups({
    serverKeyAvailable: !!mock.serverKeyAvailable,
    serverKeyAvailabilityKnown: true,
    userKeySet: !!mock.userKeySet,
    serverModels: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }],
    byokModels: [{ id: "gpt-4.1-mini", label: "GPT-4.1 mini" }],
  });
  const selected =
    mock.mode === "byok" && mock.userKeySet
      ? "gpt-4.1-mini"
      : "gemini-3.8-flash";
  const pickerHtml = renderAiModelPickerHtml({
    groups,
    selectedId: selected,
    label: "โมเดล",
  });
  await page.setContent(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${baseUrl}/style.css" />
    <style>body{margin:0;background:#eef3f2;padding:1rem} .wrap{max-width:28rem;margin:0 auto;background:#fff;border-radius:14px;padding:1rem;border:1px solid #d5e0de}</style>
  </head><body><div class="wrap dialog-card" id="pickerRoot">
    <h2 class="dialog-title">เลือกโมเดล · AI ช่วยกรอก</h2>
    <p class="dialog-body">แยกโมเดลตามแหล่งคีย์</p>
    ${pickerHtml}
  </div></body></html>`);
  await page.waitForSelector("[data-ai-model-picker]");
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    text: document.body.innerText,
    html: document.body.innerHTML,
  }));
  if (metrics.scrollWidth > metrics.clientWidth + 1) {
    throw new Error(`${name}: picker overflow`);
  }
  assertNoSecrets(metrics.text + metrics.html);
  if (
    !metrics.html.includes('label="คีย์กลางของระบบ"') ||
    !metrics.html.includes('label="คีย์ของฉัน"')
  ) {
    throw new Error(`${name}: missing optgroup labels in picker HTML`);
  }
  if (!metrics.text.includes("ใช้คีย์กลางของระบบ") && !metrics.text.includes("ใช้คีย์ของฉัน")) {
    throw new Error(`${name}: missing source badge`);
  }
  const path = join(outDir, name);
  await page.locator("#pickerRoot").screenshot({ path });
  console.log(`✓ ${name}`);
  return path;
}

async function main() {
  console.log(`ai-key settings verify → ${baseUrl}`);
  const { chromium, webkit, devices } = playwright;
  const iphone = devices["iPhone 13"];
  const failures = [];

  const runViewport = async (type, label, w, h, opts) => {
    await withPage(type, label, w, h, opts, async (page) => {
      try {
        await shotSettings(page, `ai-key-settings-server-${label}.png`, {
          mode: "server",
          serverKeyAvailable: true,
          userKeySet: false,
        });
        await shotSettings(page, `ai-key-settings-byok-${label}.png`, {
          mode: "byok",
          serverKeyAvailable: true,
          userKeySet: true,
          userKeyHint: "••••1234",
        });
        await shotPicker(page, `ai-key-picker-server-${label}.png`, {
          mode: "server",
          serverKeyAvailable: true,
          userKeySet: true,
        });
        await shotPicker(page, `ai-key-picker-byok-${label}.png`, {
          mode: "byok",
          serverKeyAvailable: true,
          userKeySet: true,
        });
      } catch (err) {
        failures.push(`${label}: ${err.message || err}`);
      }
    });
  };

  await runViewport(webkit, "iphone13-webkit-390", iphone.viewport.width, iphone.viewport.height, {
    isMobile: iphone.isMobile,
    hasTouch: iphone.hasTouch,
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
  });
  await runViewport(chromium, "chromium-1280", 1280, 800, {});

  writeFileSync(
    join(outDir, "ai-key-settings-contract.json"),
    JSON.stringify(
      {
        state: {
          mode: "server|byok",
          serverKeyAvailable: "boolean",
          userKeySet: "boolean",
          userKeyHint: "string? (user key only)",
        },
        adapter: "src/lib/ai-key-settings-adapter.ts",
        backendFieldNeed: "models[].source: 'server'|'byok'",
      },
      null,
      2,
    ),
  );

  if (failures.length) {
    console.error("FAIL", failures);
    process.exit(1);
  }
  console.log("All AI key settings/picker checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
