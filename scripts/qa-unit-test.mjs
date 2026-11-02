import assert from "node:assert/strict";
import { TagDisposition, TagPlacement } from "easy-template-x";
import {
  fieldIdentityKey,
  normalizeVarName,
  validateVarName,
} from "../src/server/field-names.ts";
import { tagsToFieldsWithWarnings } from "../src/server/docx-engine.ts";
import { formatTemplateError } from "../src/server/docx-errors.ts";
import { maskGeminiKey } from "../src/server/ai-config.ts";
import {
  UNKNOWN_CLIENT_IP,
  clientIpFromXForwardedFor,
  getTrustedProxyCount,
  rateLimitClientIp,
  resolveClientIp,
  withResolvedClientIpHeaders,
} from "../src/server/client-ip.ts";

console.log("qa-unit-test");

assert.equal(fieldIdentityKey(" Name "), fieldIdentityKey("name"));
assert.equal(normalizeVarName("  a   b  "), "a b");
assert.equal(validateVarName("ok_name"), null);
assert.ok(validateVarName("bad name!"));
console.log("✓ field-names");

const tags = [
  { name: "outer", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
  { name: "a", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "inner", disposition: TagDisposition.Open, placement: TagPlacement.TextNode },
  { name: "b", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "inner", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  { name: "outer", disposition: TagDisposition.Close, placement: TagPlacement.TextNode },
  { name: "Name", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: "name", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
  { name: " Name ", disposition: TagDisposition.SelfClosed, placement: TagPlacement.TextNode },
];
const { fields } = tagsToFieldsWithWarnings(/** @type {any} */ (tags));
const outer = fields.find((f) => f.name === "outer");
assert.ok(outer && outer.type === "list");
assert.ok(outer.itemFields.find((f) => f.type === "list" && f.name === "inner"));
const texts = fields.filter((f) => f.type === "text");
assert.equal(texts.length, 1);
assert.ok((texts[0].aliases || []).length >= 1);
console.log("✓ tagsToFields nested+dedupe");

assert.match(formatTemplateError(new Error("Tag {{#items}} is never closed")), /แท็กเปิด/);
assert.match(formatTemplateError(new Error("Can't find end of central directory")), /เสีย|เปิดไม่ได้/);
assert.match(formatTemplateError(new Error("encrypted package https://example.com/docs")), /รหัสผ่าน/);
assert.doesNotMatch(
  formatTemplateError(new Error("see https://github.com/easy-template-x for help")),
  /https?:/,
);
console.log("✓ formatTemplateError");

const masked = maskGeminiKey("ABCDEFGHIJKLMNOPQRSTUV");
assert.ok(masked.startsWith("••••"));
assert.ok(!masked.includes("ABCDEF"));
console.log("✓ maskGeminiKey");

// --- client IP / trusted proxy hops ---
assert.equal(getTrustedProxyCount(""), 1);
assert.equal(getTrustedProxyCount(undefined), 1);
assert.equal(getTrustedProxyCount("2"), 2);
assert.equal(getTrustedProxyCount("-1"), 1);
assert.equal(getTrustedProxyCount("nope"), 1);

// Single hop: rightmost (only) value is the client
assert.equal(clientIpFromXForwardedFor("203.0.113.10", 1), "203.0.113.10");
assert.equal(
  resolveClientIp(new Headers({ "x-forwarded-for": "203.0.113.10" }), {
    trustedProxyCount: 1,
  }),
  "203.0.113.10",
);

// Multiple hops: skip trusted count from the right
assert.equal(
  clientIpFromXForwardedFor("198.51.100.1, 203.0.113.50, 192.0.2.10", 2),
  "203.0.113.50",
);
assert.equal(
  resolveClientIp(
    new Headers({
      "x-forwarded-for": "198.51.100.1, 203.0.113.50, 192.0.2.10",
    }),
    { trustedProxyCount: 2 },
  ),
  "203.0.113.50",
);

// Spoofed leftmost XFF must not win when proxies append
assert.equal(
  clientIpFromXForwardedFor("8.8.8.8, 203.0.113.77", 1),
  "203.0.113.77",
);
assert.notEqual(
  resolveClientIp(
    new Headers({ "x-forwarded-for": "8.8.8.8, 203.0.113.77" }),
    { trustedProxyCount: 1 },
  ),
  "8.8.8.8",
);

// cf-connecting-ip preferred over XFF
assert.equal(
  resolveClientIp(
    new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "8.8.8.8, 198.51.100.2",
    }),
    { trustedProxyCount: 1 },
  ),
  "203.0.113.9",
);

// No headers → null; rate-limit key must not bypass
assert.equal(resolveClientIp(new Headers()), null);
assert.equal(rateLimitClientIp(null), UNKNOWN_CLIENT_IP);
assert.equal(rateLimitClientIp(""), UNKNOWN_CLIENT_IP);
assert.equal(rateLimitClientIp("not-an-ip"), UNKNOWN_CLIENT_IP);
assert.equal(rateLimitClientIp("203.0.113.9"), "203.0.113.9");

// Header rewrite: multi-hop → single trusted value for Better Auth
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", {
      headers: { "x-forwarded-for": "8.8.8.8, 203.0.113.40" },
    }),
    { trustedProxyCount: 1 },
  );
  assert.equal(req.headers.get("x-forwarded-for"), "203.0.113.40");
  // Do not invent an edge header when IP came from XFF only
  assert.equal(req.headers.get("cf-connecting-ip"), null);
}
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", {
      headers: {
        "cf-connecting-ip": "203.0.113.40",
        "x-forwarded-for": "8.8.8.8, 198.51.100.1",
      },
    }),
    { trustedProxyCount: 1 },
  );
  assert.equal(req.headers.get("cf-connecting-ip"), "203.0.113.40");
  assert.equal(req.headers.get("x-forwarded-for"), "203.0.113.40");
}
{
  const req = withResolvedClientIpHeaders(
    new Request("http://localhost/api/auth/ok", { headers: {} }),
  );
  assert.equal(req.headers.get("x-forwarded-for"), null);
  assert.equal(req.headers.get("cf-connecting-ip"), null);
}
console.log("✓ client-ip resolution");

console.log("\nAll qa unit tests passed");
