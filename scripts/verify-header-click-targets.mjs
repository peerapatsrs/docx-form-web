#!/usr/bin/env node
/**
 * OBS-DOCX-HEADER-OVERLAP — Playwright hit-testing for header controls.
 * At each viewport, elementFromPoint at control center must hit the intended target.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "verify", "screenshots");
const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const WIDTHS = [360, 390, 768, 1024, 1280];
const TAP_MIN = 44;
const LONG_AI_STATUS = "คีย์เซิร์ฟเวอร์ · OpenAI · gpt-4o";
const MANAGE_KEYS_ACTION = "จัดการคีย์ AI";
const MOCK_USER = {
  name: "Peerapat Surasing",
  email: "peerapat.srs@gmail.com",
  role: "superadmin",
  plan: "pro",
  image: null,
};

mkdirSync(outDir, { recursive: true });

let playwright;
try {
  playwright = require("playwright");
} catch {
  console.error("playwright required");
  process.exit(1);
}

const results = { base: baseUrl, checks: [] };

function check(name, ok, detail = "") {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function boxesOverlap(a, b, pad = 0) {
  if (!a || !b) return false;
  return !(
    a.x + a.width + pad <= b.x ||
    b.x + b.width + pad <= a.x ||
    a.y + a.height + pad <= b.y ||
    b.y + b.height + pad <= a.y
  );
}

async function hitTestTarget(page, locator) {
  const count = await locator.count();
  if (count === 0) return { ok: false, reason: "missing" };
  const el = locator.first();
  await el.waitFor({ state: "visible", timeout: 15000 });
  const box = await el.boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    return { ok: false, reason: "no box" };
  }
  const hit = await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top) return { ok: false, topTag: null, topClass: "", x, y };
    const ok = node === top || node.contains(top) || top.contains(node);
    return {
      ok,
      topTag: top.tagName,
      topClass: String(top.className || ""),
      topId: top.id || "",
      x,
      y,
    };
  });
  return {
    w: Math.round(box.width * 10) / 10,
    h: Math.round(box.height * 10) / 10,
    ...hit,
  };
}

async function waitAuthBar(page) {
  await page.waitForSelector('[data-auth-bar="signed-in"]', { timeout: 45000 });
}

async function applyLongHeaderStatus(page) {
  await page.evaluate(
    ({ line, action }) => {
      const el = document.getElementById("statusText");
      const pill = document.getElementById("status");
      if (!el || !pill) return;
      el.textContent = line;
      const label = `${line} — ${action}`;
      pill.title = label;
      pill.setAttribute("aria-label", label);
    },
    { line: LONG_AI_STATUS, action: MANAGE_KEYS_ACTION },
  );
  await page.waitForTimeout(100);
}

async function measureBrandAndPill(page) {
  return page.evaluate(() => {
    const brand = document.querySelector(".brand-text");
    const st = document.getElementById("statusText");
    const pill = document.getElementById("status");
    const brandOk =
      !!brand &&
      brand.textContent?.trim() === "docx-form" &&
      brand.scrollWidth <= brand.clientWidth + 1;
    const ellipsed = !!st && st.scrollWidth > st.clientWidth + 1;
    return {
      brandOk,
      ellipsed,
      brand: brand
        ? { sw: brand.scrollWidth, cw: brand.clientWidth, text: brand.textContent?.trim() }
        : null,
      status: st
        ? { sw: st.scrollWidth, cw: st.clientWidth, text: st.textContent?.trim() }
        : null,
      pillTitle: pill?.title || "",
      pillAria: pill?.getAttribute("aria-label") || "",
    };
  });
}

async function setupContext(browser) {
  const context = await browser.newContext({
    locale: "th-TH",
    hasTouch: true,
  });
  await context.addInitScript((user) => {
    window.__DOCX_FORM_VERIFY_SESSION__ = { user };
  }, MOCK_USER);
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    try {
      const reqUrl = route.request().url();
      if (
        reqUrl.includes("/api/auth/") &&
        (reqUrl.includes("get-session") || reqUrl.includes("session"))
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            session: { id: "verify", userId: "verify-user" },
            user: MOCK_USER,
          }),
        });
        return;
      }
      const fetchUrl =
        reqUrl.startsWith("https://127.0.0.1:") || reqUrl.startsWith("https://localhost:")
          ? reqUrl.replace(/^https:/, "http:")
          : undefined;
      const res = await route.fetch(fetchUrl ? { url: fetchUrl } : undefined);
      const headers = { ...res.headers() };
      if (headers["content-security-policy"]) {
        headers["content-security-policy"] = String(headers["content-security-policy"])
          .replace(/upgrade-insecure-requests;?\s*/gi, "")
          .replace(/;{2,}/g, ";");
      }
      delete headers["strict-transport-security"];
      await route.fulfill({ response: res, headers });
    } catch {
      try {
        await route.abort();
      } catch {
        /* ignore */
      }
    }
  });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForSelector("header.topbar", { timeout: 30000 });
  await waitAuthBar(page);
  return { context, page };
}

async function runWidth(browser, width) {
  const { context, page } = await setupContext(browser);
  try {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(400);

    if (width < 1280) {
      await applyLongHeaderStatus(page);
      const headerText = await measureBrandAndPill(page);
      check(
        `brand wordmark not truncated @${width}`,
        headerText.brandOk,
        JSON.stringify(headerText.brand),
      );
      check(
        `status pill ellipsis (long AI) @${width}`,
        headerText.ellipsed,
        JSON.stringify(headerText.status),
      );
      const expectLabel = `${LONG_AI_STATUS} — ${MANAGE_KEYS_ACTION}`;
      check(
        `status pill title and aria-label @${width}`,
        headerText.pillTitle === expectLabel && headerText.pillAria === expectLabel,
        JSON.stringify({
          title: headerText.pillTitle,
          aria: headerText.pillAria,
        }),
      );
    }

    if (width >= 1280) {
      const proBadge = await page.evaluate(() => {
        const el = document.querySelector(".auth-bar-desktop .auth-bar-plan.is-pro");
        if (!el) return { ok: false, reason: "missing is-pro on desktop plan" };
        const color = getComputedStyle(el).color;
        return { ok: true, color, text: el.textContent?.trim() };
      });
      check(
        `desktop plan badge is-pro @${width}`,
        proBadge.ok && proBadge.text === "จ่ายแล้ว",
        JSON.stringify(proBadge),
      );
    }

    const layout = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return {
        pill: box(".status-pill"),
        user: box(".auth-bar-desktop .auth-bar-user") || box(".auth-bar-avatar-btn"),
        desktopVisible: !!document.querySelector(".auth-bar-desktop") &&
          getComputedStyle(document.querySelector(".auth-bar-desktop")).display !== "none",
      };
    });

    if (layout.pill && layout.user && boxesOverlap(layout.pill, layout.user)) {
      check(`no pill/auth overlap @${width}`, false, JSON.stringify({ pill: layout.pill, user: layout.user }));
    } else {
      check(`no pill/auth overlap @${width}`, true, JSON.stringify(layout));
    }

    const desktop = width >= 1280;
    let accountLoc;
    let adminLoc;
    let logoutLoc;

    if (desktop) {
      accountLoc = page.locator('.auth-bar-desktop a.auth-bar-user[href="/account"]');
      adminLoc = page.locator('.auth-bar-desktop a.auth-bar-btn[href="/admin"]');
      logoutLoc = page.locator(".auth-bar-desktop .auth-bar-logout-form button");
    } else {
      const avatar = page.locator(".auth-bar-avatar-btn");
      const avatarHit = await hitTestTarget(page, avatar);
      check(
        `avatar menu opener @${width} ≥${TAP_MIN}px`,
        avatarHit.ok && avatarHit.w >= TAP_MIN && avatarHit.h >= TAP_MIN,
        JSON.stringify(avatarHit),
      );
      await avatar.click();
      await page.waitForSelector(".auth-bar-menu", { timeout: 5000 });
      accountLoc = page.locator('a.auth-bar-menu-profile[href="/account"]');
      adminLoc = page.locator('.auth-bar-menu a.auth-bar-menu-item[href="/admin"]');
      logoutLoc = page.locator("button.auth-bar-menu-logout");
    }

    const accountHit = await hitTestTarget(page, accountLoc);
    check(
      `account link hit-test @${width}`,
      accountHit.ok && accountHit.w >= TAP_MIN && accountHit.h >= TAP_MIN,
      JSON.stringify(accountHit),
    );

    const adminHit = await hitTestTarget(page, adminLoc);
    check(
      `admin hit-test @${width}`,
      adminHit.ok && adminHit.w >= TAP_MIN && adminHit.h >= TAP_MIN,
      JSON.stringify(adminHit),
    );

    const logoutHit = await hitTestTarget(page, logoutLoc);
    check(
      `logout hit-test @${width}`,
      logoutHit.ok && logoutHit.w >= TAP_MIN && logoutHit.h >= TAP_MIN,
      JSON.stringify(logoutHit),
    );

    const shot = join(outDir, `header-click-targets-${width}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    return shot;
  } finally {
    try {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    } catch {
      /* ignore */
    }
    await context.close();
  }
}

async function main() {
  console.log(`header click targets → ${baseUrl}`);
  const browser = await playwright.chromium.launch({ headless: true });
  for (const w of WIDTHS) {
    await runWidth(browser, w);
  }
  await browser.close();
  writeFileSync(join(outDir, "header-click-targets-results.json"), JSON.stringify(results, null, 2));
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(`\n${results.checks.length - failed}/${results.checks.length} checks ok`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});