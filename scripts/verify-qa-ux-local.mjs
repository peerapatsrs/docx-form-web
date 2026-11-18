#!/usr/bin/env node
/**
 * Local QA UX verification at 390 / 1280 viewports.
 * Screenshots + size/contrast assertions for the 2026-11 UX findings.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const outDir = join(root, "verify", "screenshots", "qa-ux-local");
mkdirSync(outDir, { recursive: true });

const fixtureCandidates = [
  join(root, "fixtures/fill-form/docx-form-test-tagged.docx"),
  join(root, "fixtures/docx-form-test-tagged.docx"),
  join(root, "public/examples/sample-quote.docx"),
];
const fixture = fixtureCandidates.find((p) => existsSync(p));
if (!fixture) throw new Error("no docx fixture found");

const results = { base: BASE, fixture, viewports: {}, checks: [] };

function check(name, ok, detail = "") {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function relativeLuminance(hex) {
  const h = hex.replace("#", "");
  const n =
    h.length === 3
      ? h.split("").map((c) => parseInt(c + c, 16))
      : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((x) => parseInt(x, 16));
  const [r, g, b] = n.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const light = Math.max(L1, L2);
  const dark = Math.min(L1, L2);
  return (light + 0.05) / (dark + 0.05);
}

async function measureHome(page, width) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const shot = join(outDir, `home-${width}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  const status = await page.evaluate(() => {
    const el = document.querySelector("#statusText") || document.querySelector(".status-pill");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      text: (el.textContent || "").trim(),
      overflow: cs.overflow,
      textOverflow: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    };
  });
  check(
    `home status short text not clipped @${width}`,
    status &&
      status.scrollW <= status.clientW + 1 &&
      !/\u2026|\.\.\.$/.test(status.text) &&
      !/AI ยังไม่พร้อม ·/.test(status.text),
    JSON.stringify(status),
  );

  const loginBtn = await page.evaluate(() => {
    const el =
      document.querySelector(".auth-bar-login, a[href='/login'], a[href*=\"/login\"]") ||
      document.querySelector(".auth-bar-btn");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      minH: cs.minHeight,
      text: (el.textContent || "").trim().slice(0, 40),
    };
  });
  check(
    `login tap ≥44 @${width}`,
    loginBtn && loginBtn.h >= 44,
    JSON.stringify(loginBtn),
  );

  return { shot, status, loginBtn };
}

async function measureLogin(page, width) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const shot = join(outDir, `login-${width}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  const body = await page.evaluate(() => document.body?.innerText || "");
  check(
    `login Thai no env leak @${width}`,
    /ระบบล็อกอินยังไม่พร้อม/.test(body) &&
      !/OIDC_ISSUER|OIDC_CLIENT_ID|OIDC_CLIENT_SECRET|SSO not configured/.test(body),
    body.slice(0, 240).replace(/\s+/g, " "),
  );
  return { shot, body: body.slice(0, 400) };
}

async function measureForm(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const input = await page.$('input[type="file"]');
  if (!input) {
    check(`form upload input @${width}`, false, "no file input");
    return {};
  }
  await input.setInputFiles(fixture);
  try {
    await page.waitForSelector("#formRoot, #fields, .doc-table, .list-card, .repeater", {
      timeout: 15000,
    });
  } catch {
    /* continue — assert below */
  }
  await page.waitForTimeout(800);
  let hasRemove = await page.$(".btn-remove-row");
  if (!hasRemove) {
    const addRow = page.locator("button.add-row, button:has-text('เพิ่มแถว')").first();
    if (await addRow.count()) {
      await addRow.click();
      await page.waitForTimeout(600);
    }
    hasRemove = await page.$(".btn-remove-row");
  }
  // If still missing, measure CSS via injected sample cell (same classes as app).
  if (!hasRemove) {
    await page.evaluate(() => {
      const host = document.querySelector("#app") || document.body;
      const wrap = document.createElement("div");
      wrap.id = "qa-ux-remove-probe";
      wrap.innerHTML = `<table class="doc-table doc-table-stretch doc-table-resizable"><colgroup><col class="doc-table-rownum-col" /></colgroup><tbody><tr><td class="doc-table-rownum"><span>1</span><button type="button" class="btn-remove-row" aria-label="ลบแถว 1">×</button></td></tr></tbody></table>`;
      host.appendChild(wrap);
    });
  }
  const shot = join(outDir, `form-${width}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  const remove = await page.evaluate(() => {
    const btn = document.querySelector(".btn-remove-row");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    const cell = btn.closest("td, th");
    const cellR = cell ? cell.getBoundingClientRect() : null;
    return {
      text: (btn.textContent || "").trim(),
      aria: btn.getAttribute("aria-label") || "",
      w: Math.round(r.width),
      h: Math.round(r.height),
      flexShrink: cs.flexShrink,
      whiteSpace: cs.whiteSpace,
      cellW: cellR ? Math.round(cellR.width) : null,
      cellMinW: cell ? getComputedStyle(cell).minWidth : null,
    };
  });
  check(
    `remove-row ≥44 single-line @${width}`,
    remove &&
      remove.w >= 44 &&
      remove.h >= 44 &&
      remove.flexShrink === "0" &&
      remove.whiteSpace === "nowrap" &&
      remove.text.length <= 2,
    JSON.stringify(remove),
  );

  const addTab = await page.evaluate(() => {
    const btn = document.querySelector("#addTemplateTabBtn, .multi-tab-add");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    return {
      text: (btn.textContent || "").trim(),
      aria: btn.getAttribute("aria-label") || "",
      w: Math.round(r.width),
      h: Math.round(r.height),
      overflow: cs.overflow,
      textOverflow: cs.textOverflow,
      scrollW: btn.scrollWidth,
      clientW: btn.clientWidth,
    };
  });
  check(
    `add-template label visible @${width}`,
    !addTab ||
      (addTab.scrollW <= addTab.clientW + 2 &&
        addTab.text === "+ เพิ่ม" &&
        /เพิ่มเทมเพลต/.test(addTab.aria) &&
        addTab.h >= 44),
    JSON.stringify(addTab),
  );

  const badge = await page.evaluate(() => {
    const el = document.querySelector(".badge");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor, text: el.textContent };
  });
  if (badge) {
    // Convert rgb() to hex approx for contrast — skip if color-mix
    const toHex = (rgb) => {
      const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      return (
        "#" +
        [m[1], m[2], m[3]]
          .map((x) => Number(x).toString(16).padStart(2, "0"))
          .join("")
      );
    };
    const fg = toHex(badge.color);
    // Effective bg: accent-soft over white ≈ blend
    const soft = toHex(badge.bg);
    let ratio = null;
    if (fg && soft) {
      // If soft is transparent-ish, blend with white
      const m = String(badge.bg).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
      let bgHex = soft;
      if (m && m[4] != null && Number(m[4]) < 1) {
        const a = Number(m[4]);
        const blend = (c) => Math.round(255 * (1 - a) + Number(c) * a);
        bgHex =
          "#" +
          [blend(m[1]), blend(m[2]), blend(m[3])]
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
      }
      ratio = contrastRatio(fg, bgHex);
      check(
        `badge contrast ≥4.5 @${width}`,
        ratio >= 4.5,
        `ratio=${ratio.toFixed(2)} fg=${fg} bg=${bgHex}`,
      );
    }
  }

  const taggerLabel = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    return {
      hasOld: t.includes("เลือก model"),
      hasNew: t.includes("เลือกโมเดล"),
    };
  });
  // Only assert if tagger UI is open; otherwise skip
  if (taggerLabel.hasOld || taggerLabel.hasNew) {
    check(
      `tagger เลือกโมเดล @${width}`,
      taggerLabel.hasNew && !taggerLabel.hasOld,
      JSON.stringify(taggerLabel),
    );
  }

  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      tapMin: cs.getPropertyValue("--tap-min").trim(),
      accentInk: cs.getPropertyValue("--accent-ink").trim(),
    };
  });
  check(
    `tap-min token @${width}`,
    tokens.tapMin === "44px" && !!tokens.accentInk,
    JSON.stringify(tokens),
  );

  // Clear skip tip seen so tip mounts for overlap check
  await page.evaluate(() => {
    try {
      localStorage.removeItem("docx-form-skip-tip-seen-v1");
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: "networkidle" });
  const input2 = await page.$('input[type="file"]');
  if (input2) {
    await input2.setInputFiles(fixture);
    await page.waitForTimeout(2500);
  }
  const tipOverlap = await page.evaluate(() => {
    const tip = document.querySelector(".skip-first-use-tip");
    if (!tip) return { present: false };
    const tipR = tip.getBoundingClientRect();
    const inputs = [...document.querySelectorAll(".doc-blank, .doc-table-input, input.doc-blank")];
    const overlaps = inputs
      .map((el) => {
        const r = el.getBoundingClientRect();
        if (r.height < 8 || r.width < 8) return null;
        const hit =
          tipR.left < r.right &&
          tipR.right > r.left &&
          tipR.top < r.bottom &&
          tipR.bottom > r.top;
        return hit ? { top: Math.round(r.top), label: (el.getAttribute("aria-label") || el.name || "").slice(0, 40) } : null;
      })
      .filter(Boolean);
    const cs = getComputedStyle(tip);
    return {
      present: true,
      position: cs.position,
      tipTop: Math.round(tipR.top),
      tipBottom: Math.round(tipR.bottom),
      vh: window.innerHeight,
      overlapCount: overlaps.length,
      overlaps: overlaps.slice(0, 3),
    };
  });
  if (width <= 430) {
    check(
      `skip tip no input overlap @${width}`,
      tipOverlap.present &&
        tipOverlap.position === "static" &&
        tipOverlap.overlapCount === 0,
      JSON.stringify(tipOverlap),
    );
    const tipShot = join(outDir, `form-tip-${width}.png`);
    await page.screenshot({ path: tipShot, fullPage: false });
  }

  return { shot, remove, addTab, badge, tokens, tipOverlap };
}

async function main() {
  console.log(`qa-ux verify → ${BASE}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "th-TH" });

  results.viewports[390] = {};
  results.viewports[1280] = {};

  results.viewports[390].home = await measureHome(page, 390);
  results.viewports[1280].home = await measureHome(page, 1280);
  results.viewports[390].login = await measureLogin(page, 390);
  results.viewports[1280].login = await measureLogin(page, 1280);
  results.viewports[390].form = await measureForm(page, 390);
  results.viewports[1280].form = await measureForm(page, 1280);

  // Static source checks
  const appJs = readFileSync(join(root, "public/app.js"), "utf8");
  check("source taggerAiKeyLabel เลือกโมเดล", /:\s*"เลือกโมเดล"/.test(appJs));
  const loginSrc = readFileSync(join(root, "src/app/login/page.tsx"), "utf8");
  check(
    "source login no env names",
    /ระบบล็อกอินยังไม่พร้อม/.test(loginSrc) &&
      !/OIDC_ISSUER/.test(loginSrc) &&
      !/SSO not configured/.test(loginSrc),
  );
  const css = readFileSync(join(root, "public/style.css"), "utf8");
  check("source --tap-min", /--tap-min:\s*44px/.test(css));
  check("source --accent-ink", /--accent-ink:/.test(css));
  check(
    "source pro plan uses accent-ink",
    /\.auth-bar-plan\.is-pro[\s\S]{0,120}color:\s*var\(--accent-ink\)/.test(css),
  );
  check(
    "source skip tip mobile in-flow",
    /position:\s*static/.test(css) &&
      /bottom:\s*calc\(100%\s*\+\s*8px\)/.test(css),
  );

  await browser.close();
  const failed = results.checks.filter((c) => !c.ok).length;
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.checks.length - failed}/${results.checks.length} checks ok → ${outDir}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
