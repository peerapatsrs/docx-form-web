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
  /** Banner item when a required table/list has no filled row (seeded empty rows do not count). */
  validationListNeedFilledRow: "กรอกอย่างน้อย 1 แถว",
  validationRowPrefix: (listLabel, rowNum, itemLabel) =>
    `${listLabel} แถว ${rowNum}.${itemLabel}`,
  validationAndMoreFields: (count) => `และอีก ${count} ช่อง`,
  invalidEmailSuffix: "(รูปแบบอีเมลไม่ถูกต้อง)",
  invalidEmailFieldError:
    "รูปแบบอีเมลไม่ถูกต้อง — ตรวจอีกครั้ง หรือติ๊ก “ข้าม”",
  fieldErrorPickFileOrSkip: "กรุณาเลือกไฟล์ หรือติ๊ก “ข้าม”",
  fieldErrorAddRowOrSkip: "เพิ่มแถว หรือติ๊ก “ข้าม”",

  // Placeholders
  placeholderExamplePrefix: "เช่น ",

  // List / table
  listBadgeTable: "ตาราง",
  listBadgeFromFile: "ตารางจากไฟล์",
  listBadgeList: "รายการ",
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
  aiReadyFallback: "พร้อม",
  aiConnectedPrefix: "AI · ",
  attachSource: "แนบเอกสารต้นทาง",
  attachSourceMulti: "ต้นทาง → ให้ AI กรอก JSON",
  attachSourceInputAria: "แนบเอกสารต้นทางสำหรับ AI กรอกค่า",
  attachSourceNeedKeyBanner: "ต้องใส่ AI API key ของคุณก่อนถึงจะแนบเอกสารได้",
  attachSourceTitleNeedKey: "ต้องใส่ AI key ของคุณก่อน",
  attachSourceTitleMulti:
    "แนบต้นทาง — ส่ง Export JSON ให้ AI กรอกค่า แล้วนำ JSON กลับมาใส่จอ",
  attachSourceTitleSingle: "แนบ PDF / Word / รูป — ส่งโครง JSON ให้ AI กรอกค่า",
  addTemplateInputAria: "เลือกไฟล์เทมเพลต Word เพิ่ม",
  homeLink: "← หน้าหลัก",
  homeLinkTitle: "กลับไปหน้าอัปโหลดเทมเพลต",
  createTemplate: "สร้างเทมเพลต",
  createTemplateTitle: "สร้างเทมเพลตใหม่จากเอกสารตัวอย่าง",
  createDoc: "สร้างเอกสาร",
  createDocMulti: "สร้างเอกสาร…",
  saveDraft: "บันทึกดราฟ",
  loadDraft: "โหลดดราฟ",
  multiMetaHint:
    " · แนบต้นทาง → ระบบสร้างโครง JSON → AI กรอกค่า → ใส่ลงหน้าจอ",
  stickyCtaHint:
    "จะดาวน์โหลดไฟล์ใหม่ โดยไม่แก้ไฟล์ต้นฉบับ · ช่องว่างต้องติ๊ก “ข้าม” · ส่งออก/นำเข้า JSON ได้ด้านบน · บันทึกดราฟเพื่อกลับมาทำต่อข้ามวัน",
  stickyCtaHintMulti:
    " · หลายเทมเพลต: แนบต้นทางเพื่อแมป JSON ลงจอ แล้วกดสร้างเลือกไฟล์เดียวหรือทั้งหมด",

  // Home (mockup 01 / prototype-screens.html)
  homeHeadline: "docx-form — กรอกแบบฟอร์มเอกสาร Word จากเทมเพลต .docx",
  homeSubhead:
    "อัปโหลดเทมเพลตที่มีแท็ก {{ชื่อฟิลด์}} แล้วกรอกบนหน้าเว็บ · รองรับหลายเทมเพลต · JSON · AI (BYOK)",
  homeAboutSummary: "เกี่ยวกับ docx-form",
  homeAboutBody:
    "เว็บแอปสร้างเอกสารจากเทมเพลต Microsoft Word (.docx) อ่านตัวแปรแล้วสร้างฟอร์มให้กรอก รองรับดราฟ นำเข้า/ส่งออก JSON และ AI แมปจากไฟล์ต้นทาง",
  dropzoneDrag: "ลากไฟล์ .docx มาวางที่นี่",
  dropzoneOrPick: "หรือเลือกไฟล์ · ฟรีสูงสุด 2 ไฟล์ต่อครั้ง",
  dropzonePick: "เลือกไฟล์",
  dropzoneFreeLimit: "ฟรีสูงสุด 2 ไฟล์ต่อครั้ง",
  dropzoneAriaUploadWord: "อัปโหลดไฟล์ Word",
  dropzoneAriaUploadTemplates: "อัปโหลดไฟล์เทมเพลต Word",
  showFullContentLabel: "แสดงรายละเอียดเนื้อหาในไฟล์ทั้งหมด",
  noTemplateTitle: "ยังไม่มีเทมเพลต?",
  noTemplateDesc: "ไฮไลต์ข้อความในไฟล์ตัวอย่าง แล้วแทนด้วย {{ตัวแปร}}",
  createTemplateFromDoc: "สร้างเทมเพลตจากเอกสาร",
  manualVarsDetails: "วิธีใส่ตัวแปรด้วยมือ",
  startCreateTemplate: "เริ่มสร้างเทมเพลต",
  loadDraftAria: "โหลดดราฟ",
  loadDraftEmptyLoading: "กำลังโหลดรายการดราฟ…",
  draftListLoadFailed: "อ่านรายการดราฟไม่สำเร็จ",
  loadDraftDialogBody:
    "เลือกดราฟที่บันทึกไว้ในเบราว์เซอร์นี้ (คงอยู่ข้ามวัน)",
  dialogClose: "ปิด",
  dialogCancel: "ยกเลิก",
  dialogSave: "บันทึก",
  dialogDelete: "ลบ",
  dialogLoad: "โหลด",

  // Named drafts (IndexedDB)
  draftFallbackTitle: "ดราฟ",
  draftUntitled: "ไม่มีชื่อ",
  draftSaveNoTemplate: "ยังไม่มีเทมเพลตให้บันทึกดราฟ",
  draftSaveDialogTitle: "บันทึกดราฟ",
  draftSaveDialogBody:
    "ตั้งชื่อดราฟเพื่อโหลดกลับภายหลัง (ข้ามวัน / สลับงานได้) — เก็บในเบราว์เซอร์นี้ผ่าน IndexedDB",
  draftSaveNameLabel: "ชื่อดราฟ (ไม่บังคับ)",
  draftSaveSuccess: (title) => `บันทึกดราฟแล้ว: ${title}`,
  draftSaveFailed: "บันทึกดราฟไม่สำเร็จ",
  draftMismatchTitle: "เทมเพลตต่างจากดราฟ",
  draftMismatchUnknownFile: "ไม่ทราบไฟล์",
  draftMismatchNoFile: "ยังไม่มีไฟล์",
  draftMismatchBody: (draftFile, currentFile) =>
    `ดราฟนี้มาจาก «${draftFile}» แต่ตอนนี้เปิด «${currentFile}» อยู่ — โหลดจะแทนที่ฟอร์มและไฟล์ปัจจุบันทั้งหมด`,
  draftMismatchConfirm: "โหลดแทนที่",
  draftNotFound: "ไม่พบดราฟที่เลือก",
  draftLoadIncomplete: "โหลดดราฟไม่สำเร็จ — ข้อมูลไม่ครบ",
  draftLoadSuccess: (title) => `โหลดดราฟแล้ว: ${title}`,
  draftLoadFailed: "โหลดดราฟไม่สำเร็จ",
  draftListEmpty:
    "ยังไม่มีดราฟที่บันทึกไว้ — กด «บันทึกดราฟ» ตอนกรอกฟอร์ม",
  draftDeleteTitle: "ลบดราฟนี้?",
  draftDeleteBody: "ลบแล้วกู้คืนไม่ได้ — ดราฟอื่นยังอยู่ครบ",
  draftDeleteSuccess: "ลบดราฟแล้ว",
  draftDeleteFailed: "ลบดราฟไม่สำเร็จ",
  tipKindText: "ข้อความ",
  tipKindBool: "ติ๊ก",
  tipKindAuto: "รันเลข",
  tipKindImage: "รูป",
  tipKindListTable: "ลิสต์ / ตาราง",
  tipCodeText: "{{ชื่อ}}",
  tipCodeBool: "{{พบ?√,×}}",
  tipCodeAuto: "{{+ลำดับ}}",
  tipCodeImage: "{{logo}}",
  tipCodeList: "{{#รายการ}}…{{/}}",
  tipNoteBoolLead: "หลัง",
  tipNoteBoolTrail: "คือข้อความเมื่อจริง,เท็จ",
  tipNoteAuto: "ใช้ได้เฉพาะในลูป {{#…}}…{{/}}",
  tipNoteImage: "วางรูปใน Word แล้วใส่แท็กใน Alt Text",

  // Doc preview chrome
  docPreviewLabel: "ตัวอย่างเนื้อหาในไฟล์ (กรอกในช่องว่างได้)",
  extraFieldsTitle: "ฟิลด์เพิ่มเติม",
  extraFieldsImagesTitle: "ฟิลด์เพิ่มเติม (รูปภาพ)",
});

/**
 * Cap a validation item list and append an "and N more" trailer when needed.
 * @param {string[]} items
 * @param {number} [limit]
 * @returns {string[]}
 */
export function clipValidationItems(items, limit = 12) {
  const list = Array.isArray(items) ? items.map((s) => String(s || "").trim()).filter(Boolean) : [];
  const max = Math.max(1, Number(limit) || 12);
  if (list.length <= max) return list;
  return [...list.slice(0, max), UI_LABELS.validationAndMoreFields(list.length - max)];
}

/**
 * @param {string} fieldLabel
 */
export function formatInvalidEmailMissing(fieldLabel) {
  return `${String(fieldLabel || "").trim()} ${UI_LABELS.invalidEmailSuffix}`.trim();
}

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
 * A list/table row is fully empty when every text/email cell is blank.
 * Bool/auto columns are ignored (they always have a value).
 * @param {Record<string, unknown> | null | undefined} row
 * @param {Array<{ name?: string, type?: string }> | null | undefined} itemFields
 */
export function isListRowEmpty(row, itemFields) {
  const fields = Array.isArray(itemFields) ? itemFields : [];
  const data = row && typeof row === "object" ? row : {};
  const textFields = fields.filter(
    (f) => f && f.type !== "bool" && f.type !== "auto",
  );
  if (textFields.length === 0) {
    // No fillable cells — treat as empty so seeded rows do not count as filled.
    return true;
  }
  return textFields.every((f) => !String(data[f.name] ?? "").trim());
}

/**
 * True when at least one row has any non-empty text/email cell.
 * @param {unknown} rows
 * @param {Array<{ name?: string, type?: string }> | null | undefined} itemFields
 */
export function listHasFilledRow(rows, itemFields) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some((row) => !isListRowEmpty(row, itemFields));
}

/**
 * Collect missing validation labels for a required list/table field.
 * Fully empty rows (including the seeded starter row) are not counted cell-by-cell.
 * When no filled row exists, returns a single "<label> (กรอกอย่างน้อย 1 แถว)" item.
 *
 * @param {{
 *   fieldLabel: string,
 *   itemFields: Array<{ name?: string, type?: string, label?: string }>,
 *   rows: unknown,
 *   rowSkip?: Record<number, Record<string, boolean>> | null,
 *   labelMap?: Map<string, string> | Record<string, string> | null,
 *   emailInvalid?: (raw: string) => boolean,
 *   isEmailField?: (name: string, field: { name?: string, type?: string }) => boolean,
 * }} opts
 * @returns {{ missing: string[], mode: "need-row" | "cells" }}
 */
export function collectMissingListValidation(opts) {
  const fieldLabel = String(opts?.fieldLabel || "").trim();
  const itemFields = Array.isArray(opts?.itemFields) ? opts.itemFields : [];
  const rows = Array.isArray(opts?.rows) ? opts.rows : [];
  const rowSkip = opts?.rowSkip || null;
  const labelMap = opts?.labelMap || null;
  const needRowNote =
    UI_LABELS.validationListNeedFilledRow || UI_LABELS.validationListMinRows;

  if (!listHasFilledRow(rows, itemFields)) {
    return {
      missing: [formatMissingFieldLabel(fieldLabel, needRowNote)],
      mode: "need-row",
    };
  }

  /** @type {string[]} */
  const missing = [];
  rows.forEach((row, idx) => {
    if (isListRowEmpty(row, itemFields)) return;
    for (const item of itemFields) {
      if (!item || item.type === "bool" || item.type === "auto") continue;
      if (rowSkip?.[idx]?.[item.name]) continue;
      const itemLabel = fieldDisplayLabel(item, labelMap, item.name);
      const raw = String(row?.[item.name] ?? "").trim();
      if (!raw) {
        missing.push(UI_LABELS.validationRowPrefix(fieldLabel, idx + 1, itemLabel));
      } else if (
        typeof opts.isEmailField === "function" &&
        typeof opts.emailInvalid === "function" &&
        opts.isEmailField(item.name, item) &&
        opts.emailInvalid(raw)
      ) {
        missing.push(
          formatInvalidEmailMissing(
            UI_LABELS.validationRowPrefix(fieldLabel, idx + 1, itemLabel),
          ),
        );
      }
    }
  });
  return { missing, mode: "cells" };
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

  // Same-line only: "ลูกค้า: {{customer_name}}" (do not cross newlines into table headers).
  const tagged =
    /([^\n\{\}]{1,80}?)[:：]?[ \t]*\{\{\s*([^{}#/+][^{}]*)\s*\}\}/g;
  let m;
  while ((m = tagged.exec(text))) {
    const rawCapture = String(m[1] || "");
    // Ignore tab-separated header leftovers before a cell tag.
    if (/\t/.test(rawCapture)) continue;
    const rawLabel = cleanLayoutLabel(rawCapture);
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

  // Pair a tab-separated header row with the following template-tag row.
  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = String(lines[i] || "");
    const tagLine = String(lines[i + 1] || "");
    if (!/\t/.test(headerLine) || !/\{\{/.test(tagLine)) continue;
    const headers = headerLine.split(/\t+/).map((h) => cleanLayoutLabel(h));
    const tagCells = tagLine.split(/\t+/);
    if (headers.length < 2 || tagCells.length < 2) continue;
    const n = Math.min(headers.length, tagCells.length);
    for (let c = 0; c < n; c++) {
      const tag = /\{\{\s*([^{}#/+?][^{}]*)\s*\}\}/.exec(tagCells[c] || "");
      if (!tag || !headers[c]) continue;
      const key = tag[1].trim();
      if (!map.has(key)) map.set(key, headers[c]);
    }
  }

  // Image-style lines that are mostly just {{field}} — use nearest prior short label.
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    const onlyTag = /^\{\{\s*([^{}#/+?][^{}]*)\s*\}\}$/.exec(line);
    if (!onlyTag) continue;
    const key = onlyTag[1].trim();
    if (map.has(key)) continue;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const raw = String(lines[j] || "");
      if (/\{\{/.test(raw)) continue;
      if (/\t/.test(raw)) continue;
      const labelLine = cleanLayoutLabel(raw);
      if (!labelLine || labelLine.length > 30) continue;
      map.set(key, labelLine);
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
