#!/usr/bin/env node
/**
 * Unit tests for Run Local auto sign-in target resolution.
 * When devAuthDefaultEmail is null/empty, auto login must not run.
 */
import assert from "node:assert/strict";
import { resolveDevAutoLoginUser } from "../src/lib/dev-auth-auto-login.ts";

console.log("dev-auth-auto-login-unit-test");

const users = [
  { id: "1", email: "alice@example.com", banned: false },
  { id: "2", email: "bob@example.com", banned: false },
  { id: "3", email: "banned@example.com", banned: true },
];

assert.equal(resolveDevAutoLoginUser(users, null), null);
assert.equal(resolveDevAutoLoginUser(users, undefined), null);
assert.equal(resolveDevAutoLoginUser(users, ""), null);
assert.equal(resolveDevAutoLoginUser(users, "   "), null);
console.log("✓ null/empty defaultEmail → no auto login (picker only)");

assert.equal(resolveDevAutoLoginUser(users, "bob@example.com")?.id, "2");
assert.equal(
  resolveDevAutoLoginUser(users, "  Bob@Example.com ")?.email,
  "bob@example.com",
);
console.log("✓ matching defaultEmail selects that user");

assert.equal(resolveDevAutoLoginUser(users, "nobody@example.com"), null);
assert.equal(resolveDevAutoLoginUser(users, "banned@example.com"), null);
assert.equal(resolveDevAutoLoginUser([], "alice@example.com"), null);
assert.equal(resolveDevAutoLoginUser(null, "alice@example.com"), null);
console.log("✓ missing / banned match → no auto login");

// Regression: empty preferred must NOT fall back to users[0]
assert.notEqual(
  resolveDevAutoLoginUser(users, null)?.id,
  "1",
);
assert.equal(resolveDevAutoLoginUser(users, null), null);
console.log("✓ does not fall back to users[0]");

console.log("\nAll dev-auth-auto-login unit tests passed");
