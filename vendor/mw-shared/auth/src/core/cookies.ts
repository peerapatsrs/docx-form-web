import type { CookieJarEntry } from "./types.js";

export function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out[name] = value;
  }
  return out;
}

export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  const all = parseCookieHeader(cookieHeader);
  return all[name] ?? null;
}

/** RFC 6265 token (cookie-name): 1*tchar */
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * RFC 6265 cookie-octet (cookie-value without surrounding DQUOTE):
 * %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
 * Rejects CTLs (incl. CR/LF/NUL), space, DQUOTE, comma, semicolon, backslash.
 */
const COOKIE_VALUE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** Attribute values (Path, SameSite, …): no CTLs or semicolons. */
const COOKIE_ATTR_VALUE_RE = /^[\x20-\x3A\x3C-\x7E]*$/;

function assertNoCtl(label: string, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(
        `InvalidCookie: ${label} contains control character U+${code
          .toString(16)
          .padStart(4, "0")}`,
      );
    }
  }
}

/**
 * Reject cookie name/value/attribute characters that would enable header
 * injection (CR/LF/NUL/other CTLs) or violate RFC 6265 cookie grammar.
 */
export function assertValidCookieField(
  label: string,
  value: string,
  kind: "name" | "value" | "attr",
): void {
  const s = String(value);
  assertNoCtl(label, s);
  if (kind === "name") {
    if (!COOKIE_NAME_RE.test(s)) {
      throw new Error(`InvalidCookie: ${label} is not a valid cookie-name`);
    }
    return;
  }
  if (kind === "value") {
    if (!COOKIE_VALUE_RE.test(s)) {
      throw new Error(`InvalidCookie: ${label} is not a valid cookie-value`);
    }
    return;
  }
  if (!COOKIE_ATTR_VALUE_RE.test(s) || s.includes(";")) {
    throw new Error(`InvalidCookie: ${label} is not a valid cookie attribute`);
  }
}

export function serializeCookie(entry: CookieJarEntry): string {
  assertValidCookieField("name", entry.name, "name");
  assertValidCookieField("value", entry.value, "value");

  const attrs = entry.attributes;
  const path = attrs.path ?? "/";
  assertValidCookieField("Path", path, "attr");

  const parts = [`${entry.name}=${entry.value}`];
  parts.push(`Path=${path}`);
  if (attrs.httpOnly) parts.push("HttpOnly");
  if (attrs.secure) parts.push("Secure");
  if (attrs.sameSite) {
    assertValidCookieField("SameSite", attrs.sameSite, "attr");
    parts.push(`SameSite=${attrs.sameSite}`);
  }
  if (attrs.maxAge != null) {
    if (!Number.isFinite(attrs.maxAge)) {
      throw new Error("InvalidCookie: Max-Age must be finite");
    }
    parts.push(`Max-Age=${Math.trunc(attrs.maxAge)}`);
  }
  return parts.join("; ");
}

export function expireCookie(
  name: string,
  opts: { secure?: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None" } = {},
): CookieJarEntry {
  return {
    name,
    value: "",
    attributes: {
      path: "/",
      httpOnly: opts.httpOnly ?? true,
      secure: opts.secure ?? false,
      sameSite: opts.sameSite ?? "Lax",
      maxAge: 0,
    },
  };
}

export function applySetCookies(
  headers: Headers,
  cookies: CookieJarEntry[] | undefined,
): void {
  if (!cookies) return;
  for (const c of cookies) {
    headers.append("Set-Cookie", serializeCookie(c));
  }
}

/**
 * Attach session-clear cookies to any Response (redirect or pass-through).
 * Used by adapters so validateSession().clearCookies are never dropped.
 */
export function withClearCookies(
  response: Response,
  clearCookies: CookieJarEntry[] | undefined,
): Response {
  if (!clearCookies?.length) return response;
  const headers = new Headers(response.headers);
  applySetCookies(headers, clearCookies);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
