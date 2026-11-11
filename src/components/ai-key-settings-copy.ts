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
    modeServerUnavailable: "ระบบยังไม่ได้ตั้งคีย์กลาง — เลือกคีย์ของฉันเอง หรือติดต่อผู้ดูแล",
    modeByok: "ใช้คีย์ของฉันเอง",
    modeByokSub: "วาง API key ของคุณ เก็บแบบปกปิด — ไม่แสดงค่าเต็มหลังบันทึก",
    keyLabel: "API key ของฉัน",
    keyPlaceholder: "วางคีย์ที่นี่",
    showKey: "แสดง",
    hideKey: "ซ่อน",
    saveKey: "บันทึกคีย์",
    changeKey: "เปลี่ยนคีย์",
    deleteKey: "ลบคีย์",
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
    modeByokSub: "Paste your API key (masked after save — full value is never shown again)",
    keyLabel: "My API key",
    keyPlaceholder: "Paste your key",
    showKey: "Show",
    hideKey: "Hide",
    saveKey: "Save key",
    changeKey: "Change key",
    deleteKey: "Delete key",
    savedHint: "Saved",
    saving: "Saving…",
    deleting: "Deleting…",
    loadError: "Could not load key status",
    neverShowSystem: "The system key value is never shown or requested",
  },
} as const;

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
