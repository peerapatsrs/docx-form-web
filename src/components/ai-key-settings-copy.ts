/** Thai-first copy for AI key settings (+ English when locale is en). */

export type AiKeySettingsLocale = "th" | "en";

export function resolveAiKeySettingsLocale(
  locale?: string | null,
): AiKeySettingsLocale {
  const raw = String(locale || "").toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (typeof navigator !== "undefined") {
    const nav = String(navigator.language || "").toLowerCase();
    if (nav.startsWith("en")) return "en";
  }
  return "th";
}

const COPY = {
  th: {
    title: "คีย์ AI",
    activeBadge: (label: string) => `กำลังใช้: ${label}`,
    modeServer: "ใช้คีย์กลางของระบบ",
    modeServerSub: "ไม่ต้องกรอกอะไร ระบบใช้คีย์ของบริษัทให้",
    modeServerReady: "พร้อมใช้งาน",
    modeServerUnavailable:
      "ระบบยังไม่ได้ตั้งคีย์กลาง — เลือกคีย์ของฉันเอง หรือติดต่อผู้ดูแล",
    modeByok: "ใช้คีย์ของฉันเอง",
    modeByokSub: "วาง API key ของคุณ เก็บแบบปกปิด — ไม่แสดงค่าเต็มหลังบันทึก",
    keyLabel: "API key ของฉัน",
    keyPlaceholder: "วางคีย์ที่นี่",
    showKey: "แสดง",
    hideKey: "ซ่อน",
    saveKey: "บันทึกคีย์",
    changeKey: "เปลี่ยนคีย์",
    deleteKey: "ลบคีย์",
    /** Exact confirm for PUT { deleteKey: true } — deletes ALL user keys. */
    deleteConfirm: "ลบคีย์ของฉันทั้งหมด?",
    savedHint: "บันทึกแล้ว",
    saving: "กำลังบันทึก…",
    deleting: "กำลังลบ…",
    loadError: "โหลดสถานะคีย์ไม่สำเร็จ",
    neverShowSystem: "ระบบจะไม่แสดงหรือขอค่าคีย์กลางของระบบ",
  },
  en: {
    title: "AI keys",
    activeBadge: (label: string) => `Using: ${label}`,
    modeServer: "Use the system key",
    modeServerSub: "Nothing to enter — the app uses the company key",
    modeServerReady: "Ready",
    modeServerUnavailable:
      "No system key configured — use your own key or contact an admin",
    modeByok: "Use my own key",
    modeByokSub:
      "Paste your API key (masked after save — full value is never shown again)",
    keyLabel: "My API key",
    keyPlaceholder: "Paste your key",
    showKey: "Show",
    hideKey: "Hide",
    saveKey: "Save key",
    changeKey: "Change key",
    deleteKey: "Delete key",
    deleteConfirm: "Delete all of my keys?",
    savedHint: "Saved",
    saving: "Saving…",
    deleting: "Deleting…",
    loadError: "Could not load key status",
    neverShowSystem: "The system key value is never shown or requested",
  },
} as const;

const ERROR_COPY: Record<string, { th: string; en: string }> = {
  AI_KEY_UNAUTHORIZED: {
    th: "เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่",
    en: "Session expired — please sign in again.",
  },
  AI_KEY_INVALID: {
    th: "คีย์นี้ใช้ไม่ได้ — ตรวจว่าคัดลอกครบ และเป็นคีย์ของผู้ให้บริการที่เลือก",
    en: "This API key was rejected — check that it is complete and for the selected provider.",
  },
  AI_PROVIDER_BAD_REQUEST: {
    th: "คำขอไปยังผู้ให้บริการไม่ถูกต้อง (เช่น โมเดล)",
    en: "Bad request to the provider (e.g. model).",
  },
  AI_KEY_INVALID_MODE: {
    th: "โหมดคีย์ไม่ถูกต้อง — เลือกคีย์กลางของระบบ หรือคีย์ของฉัน",
    en: "Invalid key mode — choose system key or your own key.",
  },
  AI_SERVER_KEY_UNAVAILABLE: {
    th: "คีย์กลางของระบบยังไม่พร้อม — เลือกคีย์ของฉัน หรือติดต่อผู้ดูแล",
    en: "System key is unavailable — use your own key or contact an admin.",
  },
  AI_SERVER_KEY_INVALID: {
    th: "คีย์กลางของระบบใช้ไม่ได้ชั่วคราว กรุณาแจ้งผู้ดูแลระบบ",
    en: "The system key is temporarily unavailable — please tell an admin.",
  },
  AI_KEY_SERVER_ERROR: {
    th: "เซิร์ฟเวอร์มีปัญหาขณะจัดการคีย์ — ลองใหม่ภายหลัง",
    en: "Server error while managing AI keys.",
  },
  AI_MODEL_SOURCE_MISMATCH: {
    th: "โมเดลนี้ไม่ตรงกับคีย์ที่เลือก กรุณาเลือกใหม่",
    en: "This model does not match the selected key — please pick again.",
  },
  AI_KEY_REQUIRED: {
    th: "ต้องตั้งค่าคีย์ AI ก่อน",
    en: "Set up an AI key first",
  },
};

export function aiKeySettingsCopy(locale?: string | null) {
  return COPY[resolveAiKeySettingsLocale(locale)];
}

export function modeDisplayLabel(
  mode: "server" | "byok",
  locale?: string | null,
): string {
  const c = aiKeySettingsCopy(locale);
  return mode === "server" ? c.modeServer : c.modeByok;
}

/** Map Backend error codes to Thai/EN settings copy (by code, not text). */
export function mapAiKeySettingsError(
  code: string,
  status = 0,
  locale?: string | null,
): string {
  const lang = resolveAiKeySettingsLocale(locale);
  const key = String(code || "").trim();
  if (key && ERROR_COPY[key]) {
    return lang === "en" ? ERROR_COPY[key].en : ERROR_COPY[key].th;
  }
  if (status === 401) {
    return lang === "en"
      ? ERROR_COPY.AI_KEY_UNAUTHORIZED.en
      : ERROR_COPY.AI_KEY_UNAUTHORIZED.th;
  }
  if (status >= 500) {
    return lang === "en"
      ? ERROR_COPY.AI_KEY_SERVER_ERROR.en
      : ERROR_COPY.AI_KEY_SERVER_ERROR.th;
  }
  return "";
}
