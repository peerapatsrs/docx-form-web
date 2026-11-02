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
 * Legacy equality canon: NFKC folds Thai ำ (U+0E33) ↔ ํ+า (U+0E4D U+0E32)
 * and other compatibility characters. Stored/display names stay NFC; lookups
 * may use this to find old IndexedDB / Export JSON / fill keys.
 */
export function compatKeyCanon(raw: string): string {
  return String(raw || "").normalize("NFKC");
}

/**
 * Resolve which own-key in `bag` supplies a value for `fieldName`.
 * Exact match first; else a unique key with the same NFKC canon.
 * If several keys collide under NFKC and none equals `fieldName`, return null
 * (do not guess).
 */
export function lookupCompatKey(
  bag: Record<string, unknown> | null | undefined,
  fieldName: string,
): string | null {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  if (Object.prototype.hasOwnProperty.call(bag, fieldName)) return fieldName;
  const want = compatKeyCanon(fieldName);
  if (!want) return null;
  let found: string | null = null;
  for (const k of Object.keys(bag)) {
    if (compatKeyCanon(k) !== want) continue;
    if (found != null && found !== k) return null;
    found = k;
  }
  return found;
}

export function hasCompatOwn(
  bag: Record<string, unknown> | null | undefined,
  fieldName: string,
): boolean {
  return lookupCompatKey(bag, fieldName) != null;
}

export function lookupCompatValue(
  bag: Record<string, unknown> | null | undefined,
  fieldName: string,
): { hit: boolean; key: string | null; value: unknown } {
  const key = lookupCompatKey(bag, fieldName);
  if (key == null) return { hit: false, key: null, value: undefined };
  return { hit: true, key, value: (bag as Record<string, unknown>)[key] };
}

type CompatFieldLike = {
  name: string;
  type?: string;
  aliases?: string[];
  itemFields?: CompatFieldLike[];
};

function lookupCompatAcrossNames(
  bag: Record<string, unknown> | null | undefined,
  names: string[],
): { hit: boolean; key: string | null; value: unknown } {
  for (const n of names) {
    const exact = lookupCompatValue(bag, n);
    if (exact.hit && exact.key === n) return exact;
  }
  let fallback: { hit: boolean; key: string | null; value: unknown } | null =
    null;
  for (const n of names) {
    const hit = lookupCompatValue(bag, n);
    if (!hit.hit) continue;
    if (fallback && fallback.key !== hit.key) {
      return { hit: false, key: null, value: undefined };
    }
    fallback = hit;
  }
  return fallback || { hit: false, key: null, value: undefined };
}

/**
 * Project a values bag (possibly keyed with legacy NFKC names) onto current
 * field names (NFC). Nested list rows are remapped the same way. Ambiguous
 * NFKC collisions are skipped. Aliases receive a copy of the primary value.
 */
export function projectValuesOntoFields(
  fields: CompatFieldLike[],
  values: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const bag = values && typeof values === "object" ? values : {};
  const out: Record<string, unknown> = {};

  const walk = (
    list: CompatFieldLike[],
    src: Record<string, unknown>,
    dest: Record<string, unknown>,
  ) => {
    for (const f of list) {
      const names = [f.name, ...(f.aliases || [])];
      const hit = lookupCompatAcrossNames(src, names);
      if (!hit.hit) continue;
      if (f.type === "list" && Array.isArray(hit.value)) {
        const items = f.itemFields || [];
        dest[f.name] = hit.value.map((row) => {
          const rowSrc =
            row && typeof row === "object" && !Array.isArray(row)
              ? (row as Record<string, unknown>)
              : {};
          const rowOut: Record<string, unknown> = {};
          walk(items, rowSrc, rowOut);
          return rowOut;
        });
      } else {
        dest[f.name] = hit.value;
      }
      for (const a of f.aliases || []) dest[a] = dest[f.name];
    }
  };

  walk(fields, bag as Record<string, unknown>, out);
  return out;
}

/** Remap skip / images-style flat records onto current field names. */
export function projectFlatOntoFields(
  fields: CompatFieldLike[],
  bag: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = bag && typeof bag === "object" ? bag : {};
  for (const f of fields) {
    const names = [f.name, ...(f.aliases || [])];
    const hit = lookupCompatAcrossNames(src as Record<string, unknown>, names);
    if (hit.hit) out[f.name] = hit.value;
  }
  return out;
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
