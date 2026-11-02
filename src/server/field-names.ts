/**
 * Shared variable naming: normalize, identity, and validation used by
 * parse / tagger / AI draft so create and upload agree.
 */

/**
 * Letters (incl. Thai), digits, underscore, dot, hyphen, slash.
 * Slash is allowed inside names (e.g. ที่อยู่/เบอร์). Loop close remains
 * `{{/}}` / `{{/name}}` because those start with `/` after `{{`.
 */
export const VAR_NAME_RE = /^[\w\u0E00-\u0E7F./-]+$/u;

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
    return `${kind}ใช้ได้เฉพาะตัวอักษร ตัวเลข _ . - /`;
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
    return validateVarName(n.slice(1) || n, "ชื่อลิสต์");
  }
  return validateVarName(n, "ชื่อตัวแปร");
}
