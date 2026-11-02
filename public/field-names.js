/**
 * Client field-name normalize + validate + legacy NFKC key lookup.
 * Keep FIELD_NAME_RE_SOURCE identical to src/server/field-names.ts VAR_NAME_RE_SOURCE.
 */
(function (root) {
  "use strict";

  /** @type {string} */
  const FIELD_NAME_RE_SOURCE =
    String.raw`^[\w\u0E00-\u0E7F.-]+(?:/[\w\u0E00-\u0E7F.-]+)*$`;

  const FIELD_NAME_RE = new RegExp(FIELD_NAME_RE_SOURCE, "u");

  const FIELD_NAME_ALLOWED_HINT = "ตัวอักษร ตัวเลข _ . - /";

  /**
   * @param {unknown} raw
   * @returns {string}
   */
  function normalizeFieldName(raw) {
    return String(raw || "")
      .normalize("NFC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()
      .replace(/\s+/g, " ");
  }

  /**
   * @param {unknown} raw
   * @returns {boolean}
   */
  function isValidFieldName(raw) {
    const n = normalizeFieldName(raw);
    return n.length > 0 && FIELD_NAME_RE.test(n);
  }

  /**
   * @param {unknown} raw
   * @returns {string}
   */
  function compatKeyCanon(raw) {
    return String(raw || "").normalize("NFKC");
  }

  /**
   * @param {Record<string, unknown> | null | undefined} bag
   * @param {string} fieldName
   * @returns {string | null}
   */
  function lookupCompatKey(bag, fieldName) {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
    if (Object.prototype.hasOwnProperty.call(bag, fieldName)) return fieldName;
    const want = compatKeyCanon(fieldName);
    if (!want) return null;
    let found = /** @type {string | null} */ (null);
    for (const k of Object.keys(bag)) {
      if (compatKeyCanon(k) !== want) continue;
      if (found != null && found !== k) return null;
      found = k;
    }
    return found;
  }

  /**
   * @param {Record<string, unknown> | null | undefined} bag
   * @param {string} fieldName
   * @returns {boolean}
   */
  function hasCompatOwn(bag, fieldName) {
    return lookupCompatKey(bag, fieldName) != null;
  }

  /**
   * @param {Record<string, unknown> | null | undefined} bag
   * @param {string} fieldName
   * @returns {{ hit: boolean, key: string | null, value: unknown }}
   */
  function lookupCompatValue(bag, fieldName) {
    const key = lookupCompatKey(bag, fieldName);
    if (key == null) return { hit: false, key: null, value: undefined };
    return { hit: true, key, value: bag[key] };
  }

  /**
   * @param {Record<string, unknown> | null | undefined} bag
   * @param {string[]} names
   */
  function lookupCompatAcrossNames(bag, names) {
    for (const n of names) {
      const exact = lookupCompatValue(bag, n);
      if (exact.hit && exact.key === n) return exact;
    }
    let fallback = /** @type {{ hit: boolean, key: string | null, value: unknown } | null} */ (
      null
    );
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
   * @param {Array<{ name: string, type?: string, aliases?: string[], itemFields?: any[] }>} fields
   * @param {Record<string, unknown> | null | undefined} values
   */
  function projectValuesOntoFields(fields, values) {
    const bag = values && typeof values === "object" ? values : {};
    /** @type {Record<string, unknown>} */
    const out = {};

    /**
     * @param {any[]} list
     * @param {Record<string, unknown>} src
     * @param {Record<string, unknown>} dest
     */
    const walk = (list, src, dest) => {
      for (const f of list || []) {
        const names = [f.name, ...(f.aliases || [])];
        const hit = lookupCompatAcrossNames(src, names);
        if (!hit.hit) continue;
        if (f.type === "list" && Array.isArray(hit.value)) {
          const items = f.itemFields || [];
          dest[f.name] = hit.value.map((row) => {
            const rowSrc =
              row && typeof row === "object" && !Array.isArray(row) ? row : {};
            /** @type {Record<string, unknown>} */
            const rowOut = {};
            walk(items, rowSrc, rowOut);
            return rowOut;
          });
        } else {
          dest[f.name] = hit.value;
        }
        for (const a of f.aliases || []) dest[a] = dest[f.name];
      }
    };

    walk(fields || [], /** @type {Record<string, unknown>} */ (bag), out);
    return out;
  }

  /**
   * @param {Array<{ name: string, aliases?: string[] }>} fields
   * @param {Record<string, unknown> | null | undefined} bag
   */
  function projectFlatOntoFields(fields, bag) {
    /** @type {Record<string, unknown>} */
    const out = {};
    const src = bag && typeof bag === "object" ? bag : {};
    for (const f of fields || []) {
      const names = [f.name, ...(f.aliases || [])];
      const hit = lookupCompatAcrossNames(
        /** @type {Record<string, unknown>} */ (src),
        names,
      );
      if (hit.hit) out[f.name] = hit.value;
    }
    return out;
  }

  root.DocxFieldNames = {
    FIELD_NAME_RE_SOURCE,
    FIELD_NAME_RE,
    FIELD_NAME_ALLOWED_HINT,
    normalizeFieldName,
    isValidFieldName,
    compatKeyCanon,
    lookupCompatKey,
    hasCompatOwn,
    lookupCompatValue,
    projectValuesOntoFields,
    projectFlatOntoFields,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
