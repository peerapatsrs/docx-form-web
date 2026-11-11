/**
 * Central Thai UI labels and pure display helpers for the fill form.
 * Import from app.js (ES module) and from unit tests — do not hardcode
 * these strings in components.
 */

/** @typedef {{ name: string, type?: string, label?: string, aliases?: string[], itemFields?: any[] }} LabelField */

export const UI_LABELS = Object.freeze({
  // Shared controls
  skip: "ข้าม",
  skipFieldAria: "ข้ามฟิลด์นี้ — ไม่ใส่ค่าในเอกสาร",
  skipTitle: "ข้าม — ไม่ใส่ค่าในเอกสารที่สร้าง",
  a11ySkipToContent: "ข้ามไปยังเนื้อหาหลัก",
  skipFirstUseTip:
    "ข้าม = ไม่ใส่ค่าในเอกสารที่สร้าง (ช่องจะว่างตามเทมเพลต) — ใช้เมื่อฟิลด์นั้นไม่จำเป็นในรอบนี้",
  skipFirstUseDismiss: "เข้าใจแล้ว",
  skipFirstUseStorageKey: "docx-form-skip-tip-seen-v1",

  // Validation banner
  validationTitle: (count) =>
    `ยังมี ${count} ช่องที่ยังไม่กรอก — กดชื่อช่องเพื่อไปที่นั้น หรือติ๊กข้าม`,
  validationHint: "กรอกให้ครบ หรือติ๊ก “ข้าม” — ช่องที่ข้ามแล้วไม่บังคับ",
  validationSoftEmpty: (n) => `ยังว่าง ${n} ช่อง (ข้ามได้)`,
  validationAllSkippedReady: "ติ๊กข้ามแล้ว — พร้อมสร้างได้",
  statusReady: "พร้อมใช้",
  statusGenerating: "กำลังสร้าง",
  statusEmptyFields: (n) => `มีช่องว่าง ${n}`,
  statusError: "ข้อผิดพลาด",
  statusNeedsKey: "ต้องใส่คีย์ AI",
  statusOffline: "เชื่อมต่อไม่ได้",
  postCreateToast: "ดาวน์โหลดแล้ว — ล้างช่องที่กรอกไหม?",
  postCreateKeep: "เก็บค่าไว้",
  postCreateClear: "ล้างช่อง",
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
  /** Cap long layout-derived labels so validation lists stay scannable. */
  shortValidationLabel: (label, fallback = "") => {
    const raw = String(label || "").trim();
    const fb = String(fallback || "").trim();
    // Prefer the field key when the layout label looks like a document sentence.
    const sentenceLike =
      raw.length > 28 ||
      (raw.length > 18 && /[\s，。、]/.test(raw)) ||
      /^(บริษัท|ตามที่|ขอเรียน|ของจำเลย|ดังนี้)/.test(raw);
    const text = sentenceLike && fb ? fb : raw || fb;
    if (!text) return "ช่องว่าง";
    if (text.length <= 42) return text;
    return `${text.slice(0, 40)}…`;
  },

  // Placeholders
  placeholderExamplePrefix: "เช่น ",
  /** Prefer short field key over long surrounding prose for "เช่น …". */
  examplePlaceholderLabel: (displayLabel, fieldName = "") => {
    const raw = String(displayLabel || "").trim();
    const name = String(fieldName || "").trim();
    // Prefer the field key when the surrounding/layout label is prose, not the key.
    const sentenceLike =
      (name &&
        raw &&
        raw !== name &&
        (/\s/.test(raw) || raw.length > Math.max(12, name.length + 2))) ||
      raw.length > 24 ||
      (raw.length > 14 && /\s/.test(raw) && raw !== name);
    const pick = sentenceLike && name ? name : raw || name;
    if (!pick) return "";
    return `เช่น ${pick}`;
  },

  // List / table
  listBadgeTable: "ตาราง",
  listBadgeFromFile: "ตารางจากไฟล์",
  listBadgeList: "รายการ",
  addRow: "+ เพิ่มแถว",
  removeRow: "ลบแถว",
  removeRowTitle: (n) => (n != null ? `ลบแถว ${n}` : "ลบแถว"),
  removeRowAria: (n) => (n != null ? `ลบแถว ${n}` : "ลบแถว"),
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
  toolsMenuHint: "เครื่องมือ · คีย์ AI / แนบไฟล์ / ส่งออก",
  exportJson: "ส่งออกค่า",
  exportJsonTitle: "ส่งออกค่าที่กรอกเป็นไฟล์",
  importJson: "นำเข้าค่า",
  importJsonTitle: "นำเข้าค่าจากไฟล์ที่บันทึกไว้",
  putAiKey: "ตั้งค่าคีย์ AI",
  manageAiKeys: "ตั้งค่าคีย์ AI",
  aiSuggestTags: "แนะนำแท็กจากเอกสาร",
  aiReadyFallback: "พร้อม",
  aiConnectedPrefix: "คีย์ AI · ",
  aiStatusNoKey: "AI ยังไม่พร้อม · ยังไม่มีคีย์",
  aiStatusReady: (provider) => `พร้อมใช้ AI · ${provider}`,
  aiStatusNoFile: "ยังไม่มีไฟล์",
  aiStatusEmptyCount: (n) => `ยังว่าง ${n} ช่อง`,
  aiStatusReadyCreate: "พร้อมสร้าง",
  aiStatusCreating: "กำลังสร้าง",
  aiStatusNotReadyCount: (n) => `ยังไม่พร้อม — ว่าง ${n} ช่อง`,
  attachSource: "แนบไฟล์ให้ AI ช่วยกรอก",
  attachSourceMulti: "แนบไฟล์ให้ AI ช่วยกรอก (หลายเทมเพลต)",
  attachSourceInputAria: "แนบเอกสารต้นทางสำหรับ AI กรอกค่า",
  attachSourceNeedKeyBanner: "ต้องตั้งค่าคีย์ AI ก่อนถึงจะแนบเอกสารได้",
  attachSourceTitleNeedKey: "ต้องตั้งค่าคีย์ AI ก่อน",
  attachSourceTitleMulti:
    "แนบต้นทาง — ให้ AI อ่านแล้วกรอกค่าลงหลายเทมเพลต",
  attachSourceTitleSingle: "แนบ PDF / Word / รูป — ให้ AI อ่านแล้วกรอกช่อง",
  attachSourceConfirmTitle: "ส่งไฟล์ให้ AI อ่าน?",
  attachSourceConfirmBody:
    "จะส่งไฟล์นี้ให้ AI อ่านเพื่อกรอกช่อง — ดำเนินการต่อไหม?",
  attachSourceConfirmOk: "ดำเนินการต่อ",
  addTemplateInputAria: "เลือกไฟล์เทมเพลต Word เพิ่ม",
  addTemplateBtn: "+ เพิ่มเทมเพลต",
  homeLink: "← หน้าหลัก",
  homeLinkTitle: "กลับไปหน้าอัปโหลดเทมเพลต",
  createTemplate: "สร้างเทมเพลตจากเอกสาร",
  createTemplateTitle: "สร้างเทมเพลตจากเอกสารตัวอย่าง",
  createDoc: "สร้างเอกสาร",
  createDocMulti: "สร้างเอกสาร…",
  saveDraft: "บันทึกดราฟ",
  loadDraft: "โหลดดราฟ",
  multiMetaHint: " · แนบไฟล์ให้ AI ช่วยกรอกได้จากเมนูเครื่องมือ",
  stickyCtaHint:
    "จะได้ไฟล์ใหม่ โดยไม่แก้ไฟล์ต้นฉบับ · ช่องที่ไม่ใช้ให้ติ๊กข้าม · บันทึกดราฟเพื่อทำต่อภายหลัง",
  stickyCtaHintMulti:
    " · หลายเทมเพลต: แนบไฟล์ให้ AI ช่วยกรอก แล้วกดสร้างเลือกไฟล์เดียวหรือทั้งหมด",
  uploadInvalidFile:
    "ไฟล์นี้ใช้ไม่ได้ — เลือกได้เฉพาะไฟล์ Word นามสกุล .docx",
  connectFailed: "เชื่อมต่อไม่สำเร็จ — ลองใหม่",
  connectRetry: "ลองอีกครั้ง",
  draftResumeTitle: "มีงานค้างอยู่ — ทำต่อหรือเริ่มใหม่?",
  draftResumeBody:
    "พบงานที่ค้างในเครื่องนี้ — ทำต่อจากเดิม หรือเริ่มใหม่ (ล้างค่าในเครื่อง ไม่ลบไฟล์บนเซิร์ฟเวอร์)",
  draftResumeContinue: "ทำต่อ",
  draftResumeFresh: "เริ่มใหม่",
  recentLocalWork: "งานล่าสุดในเครื่องนี้",
  generateClearToast: "ดาวน์โหลดแล้ว — ล้างช่องที่กรอกไหม?",
  generateClearKeep: "เก็บไว้",
  generateClearWipe: "ล้างช่อง",
  taggerEntryTitle: "สร้างเทมเพลตจากเอกสารตัวอย่าง",
  taggerEntrySub:
    "อัปโหลดไฟล์ Word แล้วลากคลุมข้อความที่อยากให้เป็นช่องกรอก",
  taggerPickSample: "เลือกไฟล์ตัวอย่าง",
  taggerExistingBanner: (n) =>
    `พบช่องกรอกในไฟล์ ${n} ช่อง — คลิกที่ช่องเพื่อเปลี่ยนชื่อ`,
  taggerExistingBannerNote:
    "ช่องที่มีในไฟล์อยู่แล้ว ลบในหน้านี้ไม่ได้ หากต้องการลบ ให้แก้ใน Word แล้วอัปโหลดใหม่",
  taggerMakeField: "ทำให้เป็นช่องกรอก",
  taggerShowTagCode: "ดูรหัสแท็ก",
  supportContact: "ติดต่อฝ่ายสนับสนุน",
  supportEmail: "support@tps18.space",

  // Home (mockup 01 / prototype-screens.html)
  homeHeadline: "กรอกเอกสาร Word จากเทมเพลต .docx",
  homeSubhead:
    "อัปโหลดไฟล์ที่มี {{ตัวแปร}} แล้วกรอกบนหน้าเว็บ — หลายไฟล์ · JSON · AI (BYOK)",
  homeReadMore: "อ่านเพิ่ม",
  homeAboutSummary: "เกี่ยวกับ docx-form",
  homeAboutBody:
    "เว็บแอปสร้างเอกสารจากเทมเพลต Microsoft Word (.docx) อ่านช่องว่างแล้วสร้างฟอร์มให้กรอก รองรับดราฟ และ AI ช่วยกรอกจากไฟล์ต้นทาง (ใช้คีย์ของท่านเอง)",
  dropzoneDrag: "ลากไฟล์ .docx มาวางที่นี่",
  // Fallback only — live copy uses getMaxMultiTemplates() / planQuotaLabel() (F02).
  dropzoneOrPick: "หรือเลือกไฟล์ · สูงสุดตามโควตาแผนของคุณ",
  dropzonePick: "เลือกไฟล์",
  dropzoneFreeLimit: "สูงสุดตามโควตาแผนของคุณ",
  dropzoneAriaUploadWord: "อัปโหลดไฟล์ Word",
  dropzoneAriaUploadTemplates: "อัปโหลดไฟล์เทมเพลต Word",
  showFullContentLabel: "แสดงรายละเอียดเนื้อหาในไฟล์ทั้งหมด",
  noTemplateTitle: "ยังไม่มีเทมเพลต?",
  noTemplateDesc: "อัปโหลดไฟล์ตัวอย่าง แล้วลากคลุมข้อความที่อยากให้เป็นช่องกรอก",
  createTemplateFromDoc: "สร้างเทมเพลตจากเอกสาร",
  manualVarsDetails: "สำหรับผู้จัดทำเทมเพลต",
  startCreateTemplate: "เริ่มสร้างเทมเพลต",
  loadDraftAria: "โหลดดราฟ",
  loadDraftEmptyLoading: "กำลังโหลดรายการดราฟ…",
  draftListLoadFailed: "อ่านรายการดราฟไม่สำเร็จ",
  loadDraftDialogBody:
    "เลือกงานที่บันทึกไว้ในเครื่องนี้ (อยู่ในเบราว์เซอร์นี้เท่านั้น ไม่ใช่บนบัญชี)",
  dialogClose: "ปิด",
  dialogCancel: "ยกเลิก",
  dialogSave: "บันทึก",
  dialogDelete: "ลบ",
  dialogLoad: "เปิดดราฟนี้",

  // Named drafts (IndexedDB)
  draftFallbackTitle: "ดราฟ",
  draftUntitled: "ไม่มีชื่อ",
  draftSaveNoTemplate: "ยังไม่มีเทมเพลตให้บันทึกดราฟ",
  draftSaveDialogTitle: "บันทึกดราฟ",
  draftSaveDialogBody:
    "ตั้งชื่อดราฟเพื่อเปิดกลับภายหลัง (ข้ามวัน / สลับงานได้) — เก็บเฉพาะในเบราว์เซอร์นี้ ไม่ใช่บนบัญชี",
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
  tipKindBool: "ช่องติ๊กถูก/ไม่ถูก",
  tipKindAuto: "รันเลข",
  tipKindImage: "รูป",
  tipKindListTable: "ลิสต์ / ตาราง",
  tipCodeText: "{{ชื่อ}}",
  tipCodeBool: "{{พบ?√,×}}",
  tipCodeAuto: "{{+ลำดับ}}",
  tipCodeImage: "{{logo}}",
  tipCodeList: "{{#รายการ}}…{{/}}",
  tipNoteBoolLead: "หลัง",
  tipNoteBoolTrail: "คือข้อความเมื่อถูก / ไม่ถูก (ไม่ใช่ชื่อจริง)",
  tipNoteAuto: "ใช้ได้เฉพาะในลูป {{#…}}…{{/}}",
  tipNoteImage: "วางรูปใน Word แล้วใส่แท็กใน Alt Text",
  taggerKindBoolLabel: "ช่องติ๊กถูก/ไม่ถูก",
  taggerKindBoolCode: "{{ชื่อ?ถูก,ไม่ถูก}}",
  taggerKindBoolTrue: "ข้อความเมื่อถูก",
  taggerKindBoolFalse: "ข้อความเมื่อไม่ถูก",
  draftOpenAction: "เปิดดราฟนี้",
  draftOpenDialogBody:
    "เลือกงานที่บันทึกไว้ในเครื่องนี้ (อยู่ในเบราว์เซอร์นี้เท่านั้น ไม่ใช่บนบัญชี)",
  addKeyNeedsUpgrade: "ต้องการหลายคีย์ — อัปเกรด",
  addKeyUpsellTitle: "แผนฟรีเก็บคีย์ได้ 1 อัน",
  addKeyUpsellBodyLoggedOut:
    "บัญชีฟรีเก็บ AI key ได้ 1 อันในเครื่องนี้ หากต้องการหลายคีย์ ให้เข้าสู่ระบบแล้วให้ผู้ดูแลตั้งแผนจ่ายแล้วให้ หรืออัปเกรดที่หน้าบัญชี (ยังไม่มีหน้าชำระเงินอัตโนมัติ)",
  addKeyUpsellBodyLoggedIn:
    "บัญชีฟรีเก็บ AI key ได้ 1 อัน หากต้องการหลายคีย์ ให้ผู้ดูแลตั้งแผนจ่ายแล้วให้ที่หน้าบัญชี หรือติดต่อฝ่ายสนับสนุน",
  addKeyUpsellAccount: "ไปหน้าบัญชี / เข้าสู่ระบบ",
  taggerDownloadNext:
    "ดาวน์โหลดเทมเพลตแล้ว — ใช้กรอกต่อได้เลย หรืออัปโหลดไฟล์นี้ภายหลัง",
  taggerContinueFill: "ใช้กรอกต่อ",
  outputNameTitle: "ตั้งชื่อไฟล์ที่จะดาวน์โหลด",
  outputNameLabel: "ชื่อไฟล์ (.docx)",
  outputNameConfirm: "ดาวน์โหลด",
  logoutConfirmTitle: "ออกจากระบบ?",
  logoutConfirmBody: "จะออกจากบัญชีนี้บนเครื่องนี้ — งานในเครื่อง (ดราฟ/คีย์ท้องถิ่น) ยังอยู่",
  logoutConfirmOk: "ออกจากระบบ",
  aiCancelNeutral: "ยกเลิกการรอ AI แล้ว",
  dropzoneOrPickFree: "หรือเลือกไฟล์ · สูงสุดตามโควตาแผนฟรี",
  dropzoneOrPickPaid: (n) => `หรือเลือกไฟล์ · สูงสุด ${n} ไฟล์ต่อครั้ง (แผนจ่ายแล้ว)`,
  dropzoneOrPickFreeN: (n) => `หรือเลือกไฟล์ · สูงสุด ${n} ไฟล์ต่อครั้ง (ฟรี)`,

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
export function formatInvalidEmailMissing(fieldLabel, fieldName = "") {
  const label = UI_LABELS.shortValidationLabel(fieldLabel, fieldName);
  return `${label} ${UI_LABELS.invalidEmailSuffix}`.trim();
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
export function formatExamplePlaceholder(displayLabel, fieldName = "") {
  return UI_LABELS.examplePlaceholderLabel(displayLabel, fieldName);
}

/**
 * @param {string} displayLabel
 * @param {string} [minRowsNote]
 * @param {string} [fieldName]
 */
export function formatMissingFieldLabel(displayLabel, minRowsNote, fieldName = "") {
  const label = UI_LABELS.shortValidationLabel(displayLabel, fieldName);
  if (minRowsNote) return `${label} (${minRowsNote})`;
  return label;
}

/**
 * Structured validation banner copy for unit tests / renderer.
 * @param {string[]} displayLabels
 */
export function formatValidationBannerModel(displayLabels) {
  const labels = (displayLabels || [])
    .map((s) => UI_LABELS.shortValidationLabel(s))
    .filter(Boolean);
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

  if (opts?.listSkipped) {
    return { missing: [], mode: "cells" };
  }

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

/**
 * Count required cells still empty (skipped fields/rows excluded). Pure — for status pill + tests.
 * @param {{
 *   fields: LabelField[],
 *   values: Record<string, unknown>,
 *   images?: Record<string, unknown>,
 *   skip?: Record<string, boolean>,
 *   rowSkip?: Record<string, Record<number, Record<string, boolean>>>,
 *   labelMap?: Map<string, string> | Record<string, string> | null,
 *   isEmailField?: (name: string, field: LabelField) => boolean,
 *   emailInvalid?: (raw: string) => boolean,
 * }} snap
 */
export function countEmptyRequiredFields(snap) {
  const fields = Array.isArray(snap?.fields) ? snap.fields : [];
  const values = snap?.values && typeof snap.values === "object" ? snap.values : {};
  const images = snap?.images && typeof snap.images === "object" ? snap.images : {};
  const skip = snap?.skip && typeof snap.skip === "object" ? snap.skip : {};
  const rowSkip = snap?.rowSkip && typeof snap.rowSkip === "object" ? snap.rowSkip : {};
  const labelMap = snap?.labelMap || null;

  /** @type {string[]} */
  const missing = [];
  for (const f of fields) {
    if (!f || skip[f.name]) continue;
    const fieldLabel = fieldDisplayLabel(f, labelMap, f.name);
    if (f.type === "text" || f.type === "email") {
      const raw = String(values[f.name] ?? "").trim();
      if (!raw) missing.push(fieldLabel);
      else if (
        typeof snap.isEmailField === "function" &&
        typeof snap.emailInvalid === "function" &&
        snap.isEmailField(f.name, f) &&
        snap.emailInvalid(raw)
      ) {
        missing.push(fieldLabel);
      }
    } else if (f.type === "image") {
      if (!images[f.name]) missing.push(fieldLabel);
    } else if (f.type === "list") {
      const rows = values[f.name];
      const listResult = collectMissingListValidation({
        fieldLabel,
        itemFields: f.itemFields,
        rows,
        rowSkip: rowSkip[f.name],
        labelMap,
        listSkipped: false,
        isEmailField: snap.isEmailField,
        emailInvalid: snap.emailInvalid,
      });
      missing.push(...listResult.missing);
    }
  }
  return missing.length;
}
