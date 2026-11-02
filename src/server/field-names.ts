/**
 * Shared variable naming: normalize, identity, and validation used by
 * parse / tagger / AI draft so create and upload agree.
 *
 * Keep VAR_NAME_RE_SOURCE in sync with public/field-names.js (see qa-unit-test).
 */

/**
 * One or more segments of letters (incl. Thai), digits, `_`, `.`, `-`,
 * joined by a single `/`. Rejects leading/trailing/consecutive slashes so
 * names never collide with loop-close `{{/…}}`.
 */
export const VAR_NAME_RE_SOURCE =
  String.raw`^[\w\u0E00-\u0E7F.-]+(?:/[\w\u0E00-\u0E7F.-]+)*$`;

export const VAR_NAME_RE = new RegExp(VAR_NAME_RE_SOURCE, "u");

export const VAR_NAME_ALLOWED_HINT = "ตัวอักษร ตัวเลข _ . - /";

/**
 * Trim, NFC (not NFKC — Thai ำ must stay U+0E33), strip zero-width,
 * collapse internal whitespace.
 */
export function normalizeVarName(raw: string): string {
  return String(raw || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** True when the normalized name is a legal field / list / auto label. */
export function isValidVarName(raw: string): boolean {
  const n = normalizeVarName(raw);
  return n.length > 0 && VAR_NAME_RE.test(n);
}

/**
 * Identity for deduping form fields: normalized + Latin letters lowercased.
 * Thai and other scripts are left as-is (no case fold).
 */
export function fieldIdentityKey(raw: string): string {
  const n = normalizeVarName(raw);
  return n.replace(/[A-Za-z]+/g, (m) => m.toLowerCase());
}

/** Core name used for identity of bool/auto tags (label before ? or after +). */
export function fieldCoreName(raw: string): string {
  const n = normalizeVarName(raw);
  if (n.startsWith("+")) return normalizeVarName(n.slice(1));
  const bool = /^([^?]+)\?/.exec(n);
  if (bool) return normalizeVarName(bool[1]);
  return n;
}

export function fieldIdentityKeyFromTag(raw: string): string {
  return fieldIdentityKey(fieldCoreName(raw));
}

export function validateVarName(
  name: string,
  kind = "ชื่อตัวแปร",
): string | null {
  const n = normalizeVarName(name);
  if (!n) return `${kind}ว่างไม่ได้`;
  if (!VAR_NAME_RE.test(n)) {
    return `${kind}ใช้ได้เฉพาะ${VAR_NAME_ALLOWED_HINT}`;
  }
  return null;
}

/** Validate the inner name of a self-closed / open tag against create rules. */
export function validateUploadedTagName(raw: string): string | null {
  const n = normalizeVarName(raw);
  if (!n) return "ชื่อตัวแปรว่างไม่ได้";
  if (n.startsWith("+")) return validateVarName(n.slice(1), "ชื่อรันเลข");
  // Bool label may include `/`; `?` still starts the true/false arm.
  const bool = /^([^?#{}]+)\?([^,{}]*),(.*)$/.exec(n);
  if (bool) return validateVarName(bool[1], "ชื่อตัวแปรติ๊ก");
  if (n.startsWith("#") || n.startsWith("/")) {
    // Strip the loop marker; empty after `/` is the bare `{{/}}` close (OK).
    const inner = n.slice(1);
    if (n.startsWith("/") && !inner) return null;
    return validateVarName(inner, "ชื่อลิสต์");
  }
  return validateVarName(n, "ชื่อตัวแปร");
}
