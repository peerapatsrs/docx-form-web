#!/usr/bin/env node
/**
 * Unit tests for DEV test-login panel helpers (flag on/off via HTTP status).
 * FE never sees passwords — only keys/labels when GET returns 200.
 */
import assert from "node:assert/strict";
import {
  parseTestAccountsPayload,
  resolveTestLoginRedirect,
  safeLoginNextPath,
  shouldShowTestAccountsPanel,
  TEST_ACCOUNTS_PANEL_TITLE,
} from "../src/lib/dev-test-login.ts";

console.log("dev-test-login-unit-test");

assert.equal(TEST_ACCOUNTS_PANEL_TITLE, "บัญชีทดสอบ (เฉพาะ DEV)");

assert.deepEqual(
  parseTestAccountsPayload([
    { key: "user", label: "ผู้ใช้ทดสอบ", role: "user" },
    { key: "admin", label: "แอดมินทดสอบ", role: "admin" },
  ]),
  [
    { key: "user", label: "ผู้ใช้ทดสอบ", role: "user" },
    { key: "admin", label: "แอดมินทดสอบ", role: "admin" },
  ],
);
assert.deepEqual(
  parseTestAccountsPayload({
    accounts: [{ key: "user", label: "U", role: "user" }],
  }),
  [{ key: "user", label: "U", role: "user" }],
);
assert.deepEqual(parseTestAccountsPayload(null), []);
assert.deepEqual(parseTestAccountsPayload({}), []);
assert.deepEqual(parseTestAccountsPayload([{ label: "no-key" }]), []);
assert.deepEqual(
  parseTestAccountsPayload([{ key: "  x  ", label: "", role: "" }]),
  [{ key: "x", label: "x", role: "user" }],
);
console.log("✓ parseTestAccountsPayload");

const sample = parseTestAccountsPayload([
  { key: "user", label: "ผู้ใช้ทดสอบ", role: "user" },
]);
assert.equal(shouldShowTestAccountsPanel(200, sample), true);
assert.equal(shouldShowTestAccountsPanel(200, []), false);
assert.equal(shouldShowTestAccountsPanel(404, sample), false);
assert.equal(shouldShowTestAccountsPanel(500, sample), false);
assert.equal(shouldShowTestAccountsPanel(401, sample), false);
assert.equal(shouldShowTestAccountsPanel(200, null), false);
console.log("✓ shouldShowTestAccountsPanel (200 on / 404+error off)");

assert.equal(safeLoginNextPath("/account"), "/account");
assert.equal(safeLoginNextPath("//evil.example"), "/");
assert.equal(safeLoginNextPath("https://evil.example"), "/");
assert.equal(safeLoginNextPath(null, "/login"), "/login");

assert.equal(resolveTestLoginRedirect("admin", null), "/admin");
assert.equal(resolveTestLoginRedirect("superadmin", "/"), "/admin");
assert.equal(resolveTestLoginRedirect("staff", ""), "/admin");
assert.equal(resolveTestLoginRedirect("user", null), "/");
assert.equal(resolveTestLoginRedirect("admin", "/account"), "/account");
assert.equal(resolveTestLoginRedirect("user", "/account"), "/account");
assert.equal(resolveTestLoginRedirect("user", "//evil"), "/");
console.log("✓ resolveTestLoginRedirect");

console.log("\nAll dev-test-login unit tests passed");
