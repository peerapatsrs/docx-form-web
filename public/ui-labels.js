/**
 * Central Thai UI labels and pure display helpers for the fill form.
 * Import from app.js (ES module) and from unit tests — do not hardcode
 * these strings in components.
 */

/** @typedef {{ name: string, type?: string, label?: string, aliases?: string[], itemFields?: any[] }} LabelField */

export const UI_LABELS = Object.freeze({
  // Shared controls
  skip: "ข้าม",
  skipTitle: "ข้าม — ไม่ใส่ค่าในเอกสารที่สร้าง",
  skipFirstUseTip:
    "ข้าม = ไม่ใส่ค่าในเอกสารที่สร้าง (ช่องจะว่างตามเทมเพลต) — ใช้เมื่อฟิลด์นั้นไม่จำเป็นในรอบนี้",
  skipFirstUseStorageKey: "docx-form-skip-tip-seen-v1",

  // Validation banner
  validationTitle: (count) => `ยังมีช่องที่ยังไม่ได้กรอก (${count})`,
  validationHint: "กรอกให้ครบ หรือติ๊ก “ข้าม” ก่อนสร้างเอกสาร",
  validationListMinRows: "ต้องมีอย่างน้อย 1 แถว",
  validationRowPrefix: (listLabel, rowNum, itemLabel) =>
    `${listLabel} แถว ${rowNum}.${itemLabel}`,

  // Placeholders
  placeholderExamplePrefix: "เช่น ",

  // List / table
  listBadgeTable: "ตาราง",
  listBadgeFromFile: "ตารางจากไฟล์",
  addRow: "+ เพิ่มแถว",
  removeRow: "ลบ",
  removeRowTitle: "ลบแถว",
  emptyRows: "ยังไม่มีแถว",
  emptyRowsHint: "ยังไม่มีแถว — กดเพิ่มแถว หรือติ๊กข้าม",
  seededRowTip: "เริ่มด้วย 1 แถวว่างแล้ว — กรอกหรือกด + เพิ่มแถว",
  listSkippedEmpty: "ไม่แสดงแถวในเอกสาร",
  listSkippedForm: "ข้ามรายการนี้ — จะไม่แสดงแถวในเอกสาร",
  listRowLabel: (n) => `แถว ${n}`,

  // Image upload
  imageDropHint: "วางรูปตรงนี้ในเอกสาร",
  imagePickButton: "เลือกหรือลากรูป PNG/JPEG",
  imageClear: "ลบรูป",
  imageBadge: "รูปภาพ",
  imagePreviewAlt: (label) => `พรีวิว ${label}`,
  imageEmptyTitle: "ยังไม่มีรูป",
  imageTooLarge: (label) => `รูป ${label} ใหญ่เกิน 8 MB`,

  // Toolbar
  toolsMenu: "เครื่องมือ",
  exportJson: "ส่งออก JSON",
  exportJsonTitle: "ส่งออกค่าที่กรอกเป็น JSON",
  importJson: "นำเข้า JSON",
  importJsonTitle: "นำเข้าค่าจากไฟล์ JSON",
  putAiKey: "ใส่ AI key",
  attachSource: "แนบเอกสารต้นทาง",
  homeLink: "← หน้าหลัก",
  homeLinkTitle: "กลับไปหน้าอัปโหลดเทมเพลต",
  createTemplate: "สร้างเทมเพลต",
  createTemplateTitle: "สร้างเทมเพลตใหม่จากเอกสารตัวอย่าง",
  createDoc: "สร้างเอกสาร",
  createDocMulti: "สร้างเอกสาร…",
  saveDraft: "บันทึกดราฟ",
  loadDraft: "โหลดดราฟ",

  // Home
  homeHeadline: "เติมตัวแปรใน Word",
  homeSubhead:
    "อัปโหลดเทมเพลตเพื่อเริ่มกรอก — หรือสร้างเทมเพลตจากเอกสารตัวอย่าง",
  dropzoneDrag: "ลากไฟล์ .docx มาวางที่นี่",
  dropzonePick: "เลือกไฟล์",
  dropzoneFreeLimit: "ฟรีสูงสุด 2 ไฟล์ต่อครั้ง",
  noTemplateTitle: "ยังไม่มีเทมเพลต?",
  noTemplateDesc: "ไฮไลต์ข้อความในไฟล์ตัวอย่าง แล้วแทนด้วย {{ตัวแปร}}",
  createTemplateFromDoc: "สร้างเทมเพลตจากเอกสาร",
  manualVarsDetails: "วิธีใส่ตัวแปรด้วยมือ",
  startCreateTemplate: "เริ่มสร้างเทมเพลต",

  // Doc preview chrome
  docPreviewLabel: "ตัวอย่างเนื้อหาในไฟล์ (กรอกในช่องว่างได้)",
  extraFieldsTitle: "ฟิลด์เพิ่มเติม",
  extraFieldsImagesTitle: "ฟิลด์เพิ่มเติม (รูปภาพ)",
});

/**
 * Prefer field.label, then layout-derived map, then the raw key.
 * @param {LabelField | null | undefined} field
 * @param {Map<string, string> | Record<string, string> | null | undefined} labelMap
 * @param {string} [fallbackName]
 */
export function fieldDisplayLabel(field, labelMap, fallbackName) {
  const name = String(field?.name || fallbackName || "").trim();
  if (field && typeof field.label === "string" && field.label.trim()) {
    return field.label.trim();
  }
  if (labelMap) {
    const fromMap =
      labelMap instanceof Map ? labelMap.get(name) : labelMap[name];
    if (fromMap && String(fromMap).trim()) return String(fromMap).trim();
    for (const a of field?.aliases || []) {
      const alt =
        labelMap instanceof Map ? labelMap.get(a) : labelMap[a];
      if (alt && String(alt).trim()) return String(alt).trim();
    }
  }
  return name || fallbackName || "";
}

/**
 * Placeholder for text blanks: "เช่น " + display label (never a raw EN key when label exists).
 * @param {string} displayLabel
 */
export function formatExamplePlaceholder(displayLabel) {
  const label = String(displayLabel || "").trim();
  if (!label) return "";
  return `${UI_LABELS.placeholderExamplePrefix}${label}`;
}

/**
 * @param {string} displayLabel
 * @param {string} [minRowsNote]
 */
export function formatMissingFieldLabel(displayLabel, minRowsNote) {
  const label = String(displayLabel || "").trim();
  if (minRowsNote) return `${label} (${minRowsNote})`;
  return label;
}

/**
 * Structured validation banner copy for unit tests / renderer.
 * @param {string[]} displayLabels
 */
export function formatValidationBannerModel(displayLabels) {
  const labels = (displayLabels || []).map((s) => String(s).trim()).filter(Boolean);
  return {
    title: UI_LABELS.validationTitle(labels.length),
    items: labels,
    hint: UI_LABELS.validationHint,
  };
}

/**
 * Seed one empty row when the list value is missing or empty.
 * Does not wipe existing rows. Pure helper for ensureListRows + tests.
 * @param {unknown} current
 * @returns {Record<string, unknown>[]}
 */
export function seedListRowsIfEmpty(current) {
  if (!Array.isArray(current) || current.length === 0) return [{}];
  return current;
}

/**
 * @param {string | null | undefined} stored
 */
export function shouldShowSkipFirstUseTip(stored) {
  return stored !== "1" && stored !== "true";
}

/**
 * Pull "Label: {{field}}" / heading-before-{{#list}} clues from template plain text.
 * Does not hardcode document-specific names — only pattern extraction.
 * @param {string} content
 * @param {LabelField[]} [fields]
 * @returns {Map<string, string>}
 */
export function buildLayoutLabelMap(content, fields = []) {
  /** @type {Map<string, string>} */
  const map = new Map();

  for (const f of fields || []) {
    if (f && typeof f.label === "string" && f.label.trim()) {
      map.set(f.name, f.label.trim());
    }
  }

  const text = String(content || "");
  if (!text) return map;

  // "ลูกค้า: {{customer_name}}" or "ลูกค้า {{customer_name}}"
  const tagged =
    /([^\n\{\}]{1,80}?)[:：]?\s*\{\{\s*([^{}#/+][^{}]*)\s*\}\}/g;
  let m;
  while ((m = tagged.exec(text))) {
    const rawLabel = cleanLayoutLabel(m[1]);
    const fieldName = String(m[2] || "").trim();
    if (!rawLabel || !fieldName) continue;
    if (fieldName.startsWith("?") || fieldName.startsWith("+")) continue;
    // Bool tags: name?true,false — take core name
    const boolCore = /^([^?]+)\?/.exec(fieldName);
    const key = boolCore ? boolCore[1].trim() : fieldName;
    if (!map.has(key)) map.set(key, rawLabel);
  }

  // Heading line immediately above a list open tag
  const listHead =
    /(?:^|\n)([^\n\{\}]{1,80})\n[^\n\{\}]{0,120}\{\{#\s*([^}]+)\s*\}\}/g;
  while ((m = listHead.exec(text))) {
    const rawCapture = String(m[1] || "");
    const listName = String(m[2] || "").trim();
    if (!listName) continue;
    // Skip table header rows before normalizing whitespace.
    if (/\t/.test(rawCapture) && rawCapture.split(/\t+/).length >= 2) continue;
    const rawLabel = cleanLayoutLabel(rawCapture);
    if (!rawLabel) continue;
    if (rawLabel.split(/\s+/).length >= 3 && rawLabel.length <= 40) continue;
    if (!map.has(listName)) map.set(listName, rawLabel);
  }

  // Simpler: "รายการสินค้า" on its own line, then later {{#items}}
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const open = /\{\{#\s*([^}]+)\s*\}\}/.exec(lines[i]);
    if (!open) continue;
    const listName = open[1].trim();
    if (map.has(listName)) continue;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const rawLine = String(lines[j] || "");
      // Skip table header rows (tab-separated or many short cells).
      if (/\t/.test(rawLine)) continue;
      if (/\{\{/.test(rawLine)) continue;
      const cand = cleanLayoutLabel(rawLine);
      if (!cand) continue;
      if (cand.split(/\s+/).length >= 3 && cand.length <= 40) continue;
      if (cand.length > 40) continue;
      map.set(listName, cand);
      break;
    }
  }

  // Image label: short "โลโก้:" line followed within a few lines by {{logo}} in plain or as sole content
  for (let i = 0; i < lines.length; i++) {
    const labelLine = cleanLayoutLabel(lines[i]);
    if (!labelLine || labelLine.length > 30) continue;
    if (!/[:：]?$/.test(lines[i].trim()) && !/^[\w\u0E00-\u0E7F]{1,20}$/u.test(labelLine)) {
      // allow bare short labels too
    }
    for (let j = i; j <= Math.min(lines.length - 1, i + 3); j++) {
      const img = /\{\{\s*([^{}#/+?][^{}]*)\s*\}\}/.exec(lines[j]);
      if (!img) continue;
      const key = img[1].trim();
      // Only treat as image-ish when the label line has little/no tag of its own
      if (j === i && lines[i].includes("{{")) continue;
      if (!map.has(key) && labelLine) map.set(key, labelLine);
      break;
    }
  }

  return map;
}

/**
 * @param {string} raw
 */
function cleanLayoutLabel(raw) {
  return String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s·•\-|–—]+|[\s·•\-|–—]+$/g, "")
    .replace(/[:：]\s*$/, "")
    .trim();
}

/**
 * Flatten layout blocks into plain text for label extraction.
 * @param {any[]} blocks
 * @param {string} [fileContent]
 */
export function layoutBlocksToPlainText(blocks, fileContent = "") {
  const parts = [];
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.type === "text") {
      parts.push(String(b.text || ""));
      continue;
    }
    if (b.type === "image") {
      const name = String(b.fieldName || b.name || "").trim();
      if (b.label) parts.push(`${b.label}:`);
      if (name) parts.push(`{{${name}}}`);
      continue;
    }
    if (b.type === "table") {
      if (b.listName) {
        // Keep list open visible for heading association
      }
      const rows = [
        ...(b.headerRows || []),
        ...(b.templateCells?.length ? [b.templateCells] : []),
        ...(b.trailingRows || []),
        ...(b.staticRows || []),
      ];
      for (const row of rows) {
        parts.push(
          (row || [])
            .map((c) => (typeof c === "string" ? c : c?.text || ""))
            .join("\t"),
        );
      }
      if (b.listName) {
        parts.push(`{{#${b.listName}}}`);
      }
    }
  }
  const joined = parts.join("\n");
  if (fileContent && !joined.includes(String(fileContent).slice(0, 40))) {
    return `${joined}\n${fileContent}`;
  }
  return joined || String(fileContent || "");
}

/**
 * @param {string} listName
 * @param {LabelField | null | undefined} field
 * @param {Map<string, string> | Record<string, string> | null | undefined} labelMap
 */
export function listDisplayName(listName, field, labelMap) {
  return fieldDisplayLabel(field || { name: listName }, labelMap, listName);
}
