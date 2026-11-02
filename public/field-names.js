/**
 * Client field-name normalize + validate.
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

  root.DocxFieldNames = {
    FIELD_NAME_RE_SOURCE,
    FIELD_NAME_RE,
    FIELD_NAME_ALLOWED_HINT,
    normalizeFieldName,
    isValidFieldName,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
