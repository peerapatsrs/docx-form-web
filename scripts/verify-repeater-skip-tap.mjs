#!/usr/bin/env node
/**
 * DEF-FE-REPEATER-SKIP-TAP-WIDTH — measure list-level ข้าม
 * (`.repeater-actions .skip-opt`) at 390 / 1280 in default / hover / focus / checked.
 * Field-level `.doc-skip` must remain ≥54×44 and unchanged in intent.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const outDir = join(root, "verify", "screenshots", "repeater-skip-tap");
mkdirSync(outDir, { recursive: true });

const fixtureCandidates = [
  join(root, "fixtures/fill-form/docx-form-test-tagged.docx"),
  join(root, "fixtures/docx-form-test-tagged.docx"),
];
const fixture = fixtureCandidates.find((p) => existsSync(p));
if (!fixture) throw new Error("missing tagged docx fixture");

const TAP = 44;
const results = { base: BASE, fixture, checks: [] };

function check(name, ok, detail = "") {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function ensureRepeaterSkip(page) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const input = await page.$('input[type="file"]');
  if (!input) throw new Error("no file input");
  await input.setInputFiles(fixture);
  await page.waitForSelector(".repeater-actions .skip-opt, .doc-skip", {
    timeout: 20000,
  });
  // If fixture has no list repeater, inject a probe matching app markup.
  const has = await page.$(".repeater-actions .skip-opt");
  if (!has) {
    await page.evaluate(() => {
      const host = document.querySelector("#app") || document.body;
      const wrap = document.createElement("div");
      wrap.id = "qa-repeater-skip-probe";
      wrap.innerHTML = `
        <div class="repeater">
          <div class="repeater-head">
            <h3>รายการ probe</h3>
            <div class="repeater-actions">
              <label class="skip-opt skip-opt-field" for="skip-probe">
                <input type="checkbox" id="skip-probe" aria-label="ข้ามรายการนี้" />
                <span class="skip-opt-label">ข้าม</span>
              </label>
            </div>
          </div>
        </div>
        <label class="doc-skip" title="ข้าม">
          <input type="checkbox" aria-label="ข้ามฟิลด์" />
          <span>ข้าม</span>
        </label>`;
      host.appendChild(wrap);
    });
  }
}

async function measureStates(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await ensureRepeaterSkip(page);
  await page.waitForTimeout(400);

  const shot = join(outDir, `repeater-skip-${width}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  const states = await page.evaluate(async () => {
    const el = document.querySelector(".repeater-actions .skip-opt");
    const fieldSkip = document.querySelector(".doc-skip");
    if (!el) return { error: "no .repeater-actions .skip-opt" };

    const measure = (node) => {
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      return {
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        minW: cs.minWidth,
        minH: cs.minHeight,
        flexShrink: cs.flexShrink,
      };
    };

    const input = el.querySelector('input[type="checkbox"]');
    const out = {};

    // default
    el.blur?.();
    if (input) input.checked = false;
    input?.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    out.default = measure(el);

    // hover
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.classList.add("is-measure-hover");
    // force :hover styles via temporary class if needed — also use matching CSS path
    const hoverStyle = document.createElement("style");
    hoverStyle.id = "qa-force-hover";
    hoverStyle.textContent =
      ".repeater-actions .skip-opt.is-measure-hover .skip-opt-label { max-width: 4rem; opacity: 1; }";
    document.head.appendChild(hoverStyle);
    await new Promise((r) => requestAnimationFrame(r));
    out.hover = measure(el);
    hoverStyle.remove();
    el.classList.remove("is-measure-hover");

    // focus
    input?.focus();
    await new Promise((r) => requestAnimationFrame(r));
    out.focus = measure(el);

    // checked
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await new Promise((r) => requestAnimationFrame(r));
    out.checked = measure(el);

    // reset
    if (input) {
      input.checked = false;
      input.blur();
    }

    out.fieldLevel = fieldSkip ? measure(fieldSkip) : null;
    out.tokens = {
      tapMin: getComputedStyle(document.documentElement)
        .getPropertyValue("--tap-min")
        .trim(),
    };
    return out;
  });

  if (states.error) {
    check(`repeater skip present @${width}`, false, states.error);
    return { shot, states };
  }

  for (const state of ["default", "hover", "focus", "checked"]) {
    const m = states[state];
    check(
      `repeater skip ${state} ≥${TAP}×${TAP} @${width}`,
      m && m.w >= TAP && m.h >= TAP,
      JSON.stringify(m),
    );
  }

  check(
    `repeater skip uses --tap-min @${width}`,
    states.tokens?.tapMin === "44px" &&
      states.default?.minW === "44px" &&
      states.default?.minH === "44px",
    JSON.stringify({ tokens: states.tokens, default: states.default }),
  );

  if (states.fieldLevel) {
    check(
      `field-level doc-skip still ≥54×44 @${width}`,
      states.fieldLevel.w >= 54 && states.fieldLevel.h >= 44,
      JSON.stringify(states.fieldLevel),
    );
  }

  return { shot, states };
}

async function main() {
  console.log(`repeater-skip-tap → ${BASE}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "th-TH" });

  const v390 = await measureStates(page, 390);
  const v1280 = await measureStates(page, 1280);

  await browser.close();

  const failed = results.checks.filter((c) => !c.ok).length;
  writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify({ ...results, viewports: { 390: v390, 1280: v1280 } }, null, 2),
  );
  console.log(
    `\n${results.checks.length - failed}/${results.checks.length} checks ok → ${outDir}`,
  );
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
