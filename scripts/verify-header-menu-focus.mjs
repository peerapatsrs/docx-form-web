#!/usr/bin/env node
/**
 * DEF-FE-DOCX-HEADER-MENU-FOCUS — avatar account menu keyboard focus behavior.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "verify", "screenshots");
const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const WIDTHS = [360, 768, 1024];
const MOCK_USER = {
  name: "Peerapat Surasing",
  email: "peerapat.srs@gmail.com",
  role: "superadmin",
  plan: "pro",
  image: null,
};

mkdirSync(outDir, { recursive: true });

const playwright = require("playwright");
const results = { base: baseUrl, checks: [] };

function check(name, ok, detail = "") {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function preparePage(browser, width) {
  const context = await browser.newContext({
    locale: "th-TH",
    viewport: { width, height: 800 },
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
  await page.waitForSelector('[data-auth-bar="signed-in"]', { timeout: 45000 });
  return { context, page };
}

async function focusState(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const avatar = document.querySelector(".auth-bar-avatar-btn");
    const menu = document.querySelector(".auth-bar-menu");
    return {
      menuOpen: !!menu,
      avatarFocused: active === avatar,
      activeTag: active?.tagName || "",
      activeClass: String(active?.className || ""),
    };
  });
}

async function runWidth(browser, width) {
  const { context, page } = await preparePage(browser, width);
  try {
    const avatar = page.locator(".auth-bar-avatar-btn");
    await avatar.click();
    await page.waitForSelector(".auth-bar-menu", { timeout: 5000 });
    await page.waitForTimeout(80);

    const itemCount = await page.locator(
      ".auth-bar-menu a[role='menuitem'], .auth-bar-menu button.auth-bar-menu-logout",
    ).count();
    // Focus starts on first item; one Tab per item advances; Tab from last closes menu.
    const tabs = Math.max(itemCount, 3);
    for (let i = 0; i < tabs; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(50);
    }

    const afterTab = await focusState(page);
    check(
      `tab past last closes menu @${width}`,
      !afterTab.menuOpen,
      JSON.stringify(afterTab),
    );
    check(
      `tab past last focus on avatar @${width}`,
      afterTab.avatarFocused,
      JSON.stringify(afterTab),
    );

    // Escape path
    await avatar.click();
    await page.waitForSelector(".auth-bar-menu", { timeout: 5000 });
    await page.waitForTimeout(120);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    const afterEsc = await focusState(page);
    check(`escape closes menu @${width}`, !afterEsc.menuOpen, JSON.stringify(afterEsc));
    check(
      `escape returns focus to avatar @${width}`,
      afterEsc.avatarFocused,
      JSON.stringify(afterEsc),
    );

    await page.screenshot({
      path: join(outDir, `header-menu-focus-${width}.png`),
      fullPage: false,
    });
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
  console.log(`header menu focus → ${baseUrl}`);
  const browser = await playwright.chromium.launch({ headless: true });
  for (const w of WIDTHS) {
    await runWidth(browser, w);
  }
  await browser.close();
  writeFileSync(join(outDir, "header-menu-focus-results.json"), JSON.stringify(results, null, 2));
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(`\n${results.checks.length - failed}/${results.checks.length} checks ok`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});