import { describe, expect, it } from "vitest";
import {
  safeReturnTo,
  stripSsoBypassParam,
  hasSsoBypassQuery,
} from "../src/core/safe-return.js";

describe("safeReturnTo", () => {
  const origin = "https://app.test";

  it("accepts relative paths and keeps query", () => {
    expect(safeReturnTo("/app/menu?a=1", "/", origin)).toBe("/app/menu?a=1");
    expect(safeReturnTo("/", "/", origin)).toBe("/");
  });

  it("blocks open redirects", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "/%5Cevil.example",
      "/%09/evil.example",
      "\\\\evil.example",
      "/\nevil",
    ]) {
      expect(safeReturnTo(bad, "/", origin), bad).toBe("/");
    }
  });

  it("rejects double-encoded slashes", () => {
    expect(safeReturnTo("/%252F%252Fevil", "/", origin)).toBe("/");
  });

  it("falls back when empty", () => {
    expect(safeReturnTo(null, "/app", origin)).toBe("/app");
  });
});

describe("sso query helpers", () => {
  it("detects and strips sso=1", () => {
    expect(hasSsoBypassQuery("?sso=1&x=1")).toBe(true);
    expect(stripSsoBypassParam("/packages?sso=1&y=2")).toBe("/packages?y=2");
    expect(stripSsoBypassParam("/?sso=1")).toBe("/");
    expect(stripSsoBypassParam("/app")).toBe("/app");
  });
});
