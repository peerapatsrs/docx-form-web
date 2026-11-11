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

export function serializeCookie(entry: CookieJarEntry): string {
  const attrs = entry.attributes;
  const parts = [`${entry.name}=${entry.value}`];
  parts.push(`Path=${attrs.path ?? "/"}`);
  if (attrs.httpOnly) parts.push("HttpOnly");
  if (attrs.secure) parts.push("Secure");
  if (attrs.sameSite) parts.push(`SameSite=${attrs.sameSite}`);
  if (attrs.maxAge != null) parts.push(`Max-Age=${attrs.maxAge}`);
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
