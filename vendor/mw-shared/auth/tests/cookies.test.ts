import { describe, expect, it } from "vitest";
import {
  serializeCookie,
  assertValidCookieField,
  withClearCookies,
  expireCookie,
} from "../src/core/cookies.js";

describe("serializeCookie CRLF / CTL rejection (DEF-BE-COOKIE-SERIALIZE-CRLF)", () => {
  it("serializes a normal cookie", () => {
    expect(
      serializeCookie({
        name: "mw_session",
        value: "abc.def",
        attributes: { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 60 },
      }),
    ).toBe("mw_session=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60");
  });

  it("throws when value contains CR/LF (header injection)", () => {
    expect(() =>
      serializeCookie({
        name: "mw_session",
        value: "ok\r\nSet-Cookie: injected=1",
        attributes: { path: "/" },
      }),
    ).toThrow(/InvalidCookie/);
  });

  it("throws on NUL and other CTLs in name or value", () => {
    expect(() =>
      serializeCookie({
        name: "mw\0session",
        value: "x",
        attributes: { path: "/" },
      }),
    ).toThrow(/InvalidCookie/);
    expect(() =>
      serializeCookie({
        name: "mw_session",
        value: "x\u0007y",
        attributes: { path: "/" },
      }),
    ).toThrow(/InvalidCookie/);
  });

  it("throws on RFC 6265-invalid cookie-value characters", () => {
    expect(() =>
      serializeCookie({
        name: "mw_session",
        value: 'a"b',
        attributes: { path: "/" },
      }),
    ).toThrow(/InvalidCookie/);
    expect(() =>
      serializeCookie({
        name: "mw_session",
        value: "a;b",
        attributes: { path: "/" },
      }),
    ).toThrow(/InvalidCookie/);
    expect(() =>
      serializeCookie({
        name: "mw_session",
        value: "a b",
        attributes: { path: "/" },
      }),
    ).toThrow(/InvalidCookie/);
  });

  it("assertValidCookieField rejects CTLs in attributes", () => {
    expect(() => assertValidCookieField("Path", "/\r\nx", "attr")).toThrow(
      /InvalidCookie/,
    );
  });

  it("withClearCookies appends expire Set-Cookie", () => {
    const res = withClearCookies(
      new Response(null, { status: 307, headers: { Location: "/api/auth/oidc/silent" } }),
      [expireCookie("mw_session", { secure: false, httpOnly: true })],
    );
    expect(res.status).toBe(307);
    const set = res.headers.getSetCookie?.() ?? [];
    expect(set.some((c) => /^mw_session=/.test(c) && /Max-Age=0/i.test(c))).toBe(
      true,
    );
  });
});
