#!/usr/bin/env node
/**
 * Header mobile layout verify (feat/oidc-sso).
 * Mocks logged-in AuthBar via window.__DOCX_FORM_VERIFY_SESSION__.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node scripts/verify-header-mobile.mjs
 *   HEADER_VERIFY_MODE=before|after  (default after) — filename suffix
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "verify", "screenshots");
const mode = String(process.env.HEADER_VERIFY_MODE || "after").trim() || "after";
const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

let playwright;
try {
  playwright = require("playwright");
} catch {
  console.error("playwright is required: npm i -D playwright && npx playwright install chromium webkit");
  process.exit(1);
}

const MOCK_USER = {
  name: "Peerapat Surasing",
  email: "peerapat.srs@gmail.com",
  role: "superadmin",
  plan: "pro",
  image: null,
};

mkdirSync(outDir, { recursive: true });

function boxesOverlap(a, b, pad = 0) {
  return !(
    a.x + a.width + pad <= b.x ||
    b.x + b.width + pad <= a.x ||
    a.y + a.height + pad <= b.y ||
    b.y + b.height + pad <= a.y
  );
}

async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc.scrollWidth, body?.scrollWidth || 0);
    const clientWidth = doc.clientWidth;
    const topbar = document.querySelector("header.topbar");
    const brand = document.querySelector(".brand");
    const brandText = document.querySelector(".brand-text");
    const brandVer = document.querySelector(".brand-ver");
    const avatar =
      document.querySelector(".auth-bar-avatar-btn") ||
      document.querySelector(".auth-bar-user .auth-bar-avatar, .auth-bar-user .auth-bar-avatar-fallback");
    const name =
      document.querySelector(".auth-bar-desktop .auth-bar-name") ||
      document.querySelector(".auth-bar-menu .auth-bar-name") ||
      document.querySelector(".auth-bar-name");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, text: (el.textContent || "").trim() };
    };
    const nameStyle = name ? getComputedStyle(name) : null;
    const userLink = document.querySelector(".auth-bar-user");
    const userStyle = userLink ? getComputedStyle(userLink) : null;
    return {
      scrollWidth,
      clientWidth,
      overflow: scrollWidth > clientWidth + 1,
      topbar: box(topbar),
      brand: box(brand),
      brandText: box(brandText),
      brandVer: box(brandVer),
      avatar: box(avatar),
      name: box(name),
      nameDecoration: nameStyle?.textDecorationLine || nameStyle?.textDecoration || "",
      nameColor: nameStyle?.color || "",
      userDecoration: userStyle?.textDecorationLine || userStyle?.textDecoration || "",
      menuOpen: !!document.querySelector(".auth-bar-menu"),
      avatarExpanded: document
        .querySelector(".auth-bar-avatar-btn")
        ?.getAttribute("aria-expanded"),
    };
  });
}

async function shot(page, name) {
  const path = join(outDir, name);
  const header = page.locator("header.topbar");
  await header.waitFor({ state: "visible", timeout: 15000 });
  // Full viewport shot + cropped header
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function waitAuthBar(page) {
  await page.waitForFunction(
    () =>
      !!document.querySelector('[data-auth-bar="signed-in"]') ||
      !!document.querySelector(".auth-bar-desktop .auth-bar-user") ||
      !!document.querySelector(".auth-bar-avatar-btn"),
    { timeout: 45000 },
  );
}

async function runViewport(browserType, label, width, height, opts = {}) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: opts.deviceScaleFactor || 1,
    isMobile: !!opts.isMobile,
    hasTouch: !!opts.hasTouch,
    userAgent: opts.userAgent,
  });
  if (mode !== "before") {
    await context.addInitScript((user) => {
      window.__DOCX_FORM_VERIFY_SESSION__ = { user };
    }, MOCK_USER);
  }

  const page = await context.newPage();
  // Local HTTP verify: strip upgrade-insecure-requests / HSTS so WebKit does not
  // rewrite asset URLs to https://127.0.0.1 (no TLS on the Next server).
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
        /* page already closed */
      }
    }
  });

  const pageFailures = [];
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForSelector("header.topbar", { timeout: 30000 });

    if (mode === "before") {
      // Inject the pre-fix signed-in AuthBar markup (link-styled name + inline cluster).
      await page.evaluate((user) => {
        const host = document.querySelector(".topbar-end");
        if (!host) return;
        let bar = host.querySelector(".auth-bar");
        if (!bar) {
          bar = document.createElement("div");
          bar.className = "auth-bar";
          host.prepend(bar);
        }
        const initial = String(user.name || "P")
          .trim()
          .charAt(0)
          .toUpperCase();
        bar.innerHTML = `
          <a class="auth-bar-user" href="/account" title="${user.email}">
            <span class="auth-bar-avatar auth-bar-avatar-fallback" aria-hidden>${initial}</span>
            <span class="auth-bar-name">${user.name}</span>
            <span class="auth-bar-plan">จ่ายแล้ว</span>
          </a>
          <a class="auth-bar-btn auth-bar-ghost" href="/admin">Admin</a>
          <button type="button" class="auth-bar-btn auth-bar-ghost">ออกจากระบบ</button>
        `;
        bar.setAttribute("data-auth-bar", "signed-in");
      }, MOCK_USER);
    } else {
      await waitAuthBar(page);
      // Give React a beat to swap loading → signed-in on slower WebKit.
      await page.waitForSelector('[data-auth-bar="signed-in"]', { timeout: 30000 });
    }

    const closedName = `header-mobile-${label}-closed-${mode}.png`;
    const closedPath = await shot(page, closedName);
    const closed = await measure(page);

    const assertLayout = mode !== "before";
    if (assertLayout) {
      if (closed.overflow) {
        pageFailures.push(
          `${label} closed: horizontal overflow scrollWidth=${closed.scrollWidth} > clientWidth=${closed.clientWidth}`,
        );
      }
      if (closed.avatar && closed.brandText && boxesOverlap(closed.avatar, closed.brandText)) {
        pageFailures.push(`${label} closed: avatar overlaps brand title`);
      }
      if (closed.avatar && closed.brandVer && boxesOverlap(closed.avatar, closed.brandVer)) {
        pageFailures.push(`${label} closed: avatar overlaps version`);
      }
      if (closed.name && closed.brandText && boxesOverlap(closed.name, closed.brandText)) {
        pageFailures.push(`${label} closed: name overlaps brand title`);
      }
      if (closed.name && closed.brandVer && boxesOverlap(closed.name, closed.brandVer)) {
        pageFailures.push(`${label} closed: name overlaps version`);
      }
      if (closed.nameDecoration && !/none/i.test(closed.nameDecoration)) {
        pageFailures.push(`${label}: name has text-decoration ${closed.nameDecoration}`);
      }
      if (closed.userDecoration && !/none/i.test(closed.userDecoration)) {
        pageFailures.push(`${label}: auth-bar-user has text-decoration ${closed.userDecoration}`);
      }
    } else {
      writeFileSync(
        join(outDir, `header-metrics-${label}-before.json`),
        JSON.stringify(closed, null, 2),
      );
    }

    let openPath = null;
    const avatarBtn = page.locator(".auth-bar-avatar-btn");
    if ((await avatarBtn.count()) > 0 && (await avatarBtn.isVisible())) {
      await avatarBtn.click();
      await page.waitForSelector(".auth-bar-menu", { timeout: 5000 });
      const openName = `header-mobile-${label}-open-${mode}.png`;
      openPath = await shot(page, openName);
      const open = await measure(page);
      if (assertLayout) {
        if (open.overflow) {
          pageFailures.push(`${label} open: horizontal overflow scrollWidth=${open.scrollWidth}`);
        }
        if (open.avatarExpanded !== "true") {
          pageFailures.push(`${label} open: aria-expanded != true`);
        }
        const menuBox = await page.evaluate(() => {
          const el = document.querySelector(".auth-bar-menu");
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: r.x,
            width: r.width,
            clientWidth: document.documentElement.clientWidth,
          };
        });
        if (menuBox && (menuBox.x < -1 || menuBox.x + menuBox.width > menuBox.clientWidth + 1)) {
          pageFailures.push(
            `${label} open: menu outside viewport x=${menuBox.x} w=${menuBox.width} vw=${menuBox.clientWidth}`,
          );
        }
      }
      // Escape closes
      await page.keyboard.press("Escape");
      await page.waitForSelector(".auth-bar-menu", { state: "detached", timeout: 5000 });
    } else if (assertLayout && width < 640) {
      pageFailures.push(`${label}: expected visible .auth-bar-avatar-btn under 640px`);
    }

    // Desktop: avatar menu must stay hidden
    if (assertLayout && width >= 1024) {
      if ((await avatarBtn.count()) > 0 && (await avatarBtn.isVisible())) {
        pageFailures.push(`${label}: avatar menu button should be hidden on desktop`);
      }
      const desktop = page.locator(".auth-bar-desktop");
      if ((await desktop.count()) > 0 && !(await desktop.isVisible())) {
        pageFailures.push(`${label}: desktop auth cluster should be visible`);
      }
      if ((await desktop.count()) === 0 && !(await page.locator(".auth-bar-user").isVisible())) {
        pageFailures.push(`${label}: desktop auth cluster should be visible`);
      }
    }

    console.log(
      `✓ ${label} ${width}x${height} closed=${closedPath}${openPath ? ` open=${openPath}` : ""} overflow=${closed.overflow}`,
    );
    return { failures: pageFailures, closed, closedPath, openPath };
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

async function main() {
  console.log(`header verify → ${baseUrl} mode=${mode}`);
  const { chromium, webkit, devices } = playwright;
  const iphone = devices["iPhone 13"];
  const allFailures = [];

  // WebKit iPhone 13 (~390)
  {
    const r = await runViewport(webkit, "iphone13-webkit-390", iphone.viewport.width, iphone.viewport.height, {
      isMobile: iphone.isMobile,
      hasTouch: iphone.hasTouch,
      userAgent: iphone.userAgent,
      deviceScaleFactor: iphone.deviceScaleFactor,
    });
    allFailures.push(...r.failures);
  }

  // Chromium 360 / 430
  for (const w of [360, 430]) {
    const r = await runViewport(chromium, `chromium-${w}`, w, 800, {
      isMobile: true,
      hasTouch: true,
    });
    allFailures.push(...r.failures);
  }

  // Also assert 375 / 414 quickly (overflow only + shot)
  for (const w of [375, 414]) {
    const r = await runViewport(chromium, `chromium-${w}`, w, 800, {
      isMobile: true,
      hasTouch: true,
    });
    allFailures.push(...r.failures);
  }

  // Desktop 1280
  {
    const r = await runViewport(chromium, "desktop-1280", 1280, 800, {});
    allFailures.push(...r.failures);
    writeFileSync(
      join(outDir, `header-desktop-1280-metrics-${mode}.json`),
      JSON.stringify(r.closed, null, 2),
    );
  }

  if (allFailures.length) {
    console.error("\nFAIL:");
    for (const f of allFailures) console.error(" -", f);
    process.exit(1);
  }
  console.log("\nAll header layout checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
