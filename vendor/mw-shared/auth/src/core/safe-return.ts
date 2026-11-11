/**
 * Open-redirect-proof return path sanitizer.
 * Only same-origin relative paths starting with a single `/` are accepted.
 */
export function safeReturnTo(
  raw: string | null | undefined,
  fallback = "/",
  publicOrigin?: string,
): string {
  const fallbackSafe =
    fallback.startsWith("/") && !fallback.startsWith("//") ? fallback : "/";
  let value = String(raw ?? "").trim();
  if (!value) return fallbackSafe;

  // Iteratively decode to catch double-encoding.
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      return fallbackSafe;
    }
  }

  if (!value.startsWith("/") || value.startsWith("//")) return fallbackSafe;
  if (value.includes("\\") || value.includes("\0")) return fallbackSafe;
  if (/[\x00-\x1f\x7f]/.test(value)) return fallbackSafe;
  if (value.length > 1 && (value[1] === "/" || value[1] === "\\")) {
    return fallbackSafe;
  }

  const lower = value.toLowerCase();
  if (lower.includes("%2f%2f") || lower.includes("%5c")) return fallbackSafe;

  const pathOnly = value.split("#")[0] || "/";

  if (publicOrigin) {
    try {
      const resolved = new URL(pathOnly, publicOrigin);
      const origin = new URL(publicOrigin).origin;
      if (resolved.origin !== origin) return fallbackSafe;
      return `${resolved.pathname}${resolved.search}` || "/";
    } catch {
      return fallbackSafe;
    }
  }

  return pathOnly || "/";
}

export function stripSsoBypassParam(pathWithQuery: string): string {
  const raw = String(pathWithQuery || "/");
  const qIndex = raw.indexOf("?");
  if (qIndex < 0) return raw || "/";
  const path = raw.slice(0, qIndex) || "/";
  const params = new URLSearchParams(raw.slice(qIndex + 1));
  if (!params.has("sso")) return raw;
  params.delete("sso");
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

export function hasSsoBypassQuery(search: string): boolean {
  const raw = String(search || "");
  const q = raw.startsWith("?") ? raw.slice(1) : raw;
  try {
    return new URLSearchParams(q).get("sso") === "1";
  } catch {
    return false;
  }
}

export function safeAppReturnPath(pathname: string, search = ""): string {
  const raw = `${pathname}${search}`;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  if (raw.length > 1 && (raw[1] === "/" || raw[1] === "\\")) return "/";
  return raw.split("#")[0] || "/";
}
