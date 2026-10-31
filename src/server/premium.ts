/**
 * Paid / premium feature gate — build features first, enforce later.
 *
 * Phase 1 (now): all features unlocked (`PREMIUM_ENFORCE` unset/false).
 * Phase 2: set PREMIUM_ENFORCE=1 and plug `resolveEntitlement()` (Stripe, etc.).
 */

export const PremiumFeature = {
  AiSourceMap: "ai_source_map",
  AiLogin: "ai_login",
  TemplateTagger: "template_tagger",
  OcrImages: "ocr_images",
  BatchFill: "batch_fill",
} as const;

export type PremiumFeatureId =
  (typeof PremiumFeature)[keyof typeof PremiumFeature];

export type Entitlement = {
  /** True when the caller may use paid features */
  paid: boolean;
  /** Optional plan label for UI */
  plan?: "free" | "pro" | "unknown";
  /** Opaque user/customer id when auth exists */
  customerId?: string | null;
};

/** Catalog for UI / docs — not enforced until PREMIUM_ENFORCE=1 */
export const PREMIUM_FEATURE_META: Record<
  PremiumFeatureId,
  { title: string; description: string }
> = {
  [PremiumFeature.AiSourceMap]: {
    title: "แมปเอกสารด้วย AI",
    description: "แนบ PDF/Word/รูป แล้วให้ Gemini เติมฟอร์ม",
  },
  [PremiumFeature.AiLogin]: {
    title: "เชื่อมต่อ Google AI",
    description: "บันทึก Gemini API key สำหรับแมปอัตโนมัติ",
  },
  [PremiumFeature.TemplateTagger]: {
    title: "สร้างเทมเพลตจากเอกสาร",
    description: "ไฮไลต์ข้อความแล้วใส่ {{ตัวแปร}} คงเลย์เอาต์ Word",
  },
  [PremiumFeature.OcrImages]: {
    title: "OCR รูปภาพ",
    description: "อ่านข้อความจากรูปประกอบเอกสารต้นทาง",
  },
  [PremiumFeature.BatchFill]: {
    title: "กรอกหลายไฟล์",
    description: "ประมวลผลเทมเพลตหลายชุดในครั้งเดียว (เตรียมไว้)",
  },
};

function enforceEnabled(): boolean {
  const v = String(process.env.PREMIUM_ENFORCE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Resolve paid entitlement from Better Auth session (when enforce is on).
 * Later: combine with Stripe subscription lookup.
 */
export async function resolveEntitlement(
  req?: Request,
): Promise<Entitlement> {
  let customerId: string | null = null;
  if (req) {
    try {
      const { auth } = await import("./auth");
      const session = await auth.api.getSession({ headers: req.headers });
      customerId = session?.user?.id ?? null;
    } catch {
      customerId = null;
    }
  }

  // Dev / pre-paywall: treat everyone as paid unless enforce + unpaid stub.
  if (!enforceEnabled()) {
    return { paid: true, plan: "pro", customerId };
  }

  const bypass = String(process.env.PREMIUM_BYPASS_KEY || "").trim();
  const headerKey = req?.headers.get("x-premium-bypass")?.trim() || "";
  if (bypass && headerKey && bypass === headerKey) {
    return { paid: true, plan: "pro", customerId: customerId || "bypass" };
  }

  // Enforcing: signed-in users are pro until Stripe is wired.
  if (customerId) {
    return { paid: true, plan: "pro", customerId };
  }
  return { paid: false, plan: "free", customerId: null };
}

export async function canUseFeature(
  feature: PremiumFeatureId,
  req?: Request,
): Promise<{ allowed: boolean; entitlement: Entitlement; feature: PremiumFeatureId }> {
  const entitlement = await resolveEntitlement(req);
  // All catalog features are "premium"; free tier has none until defined.
  const allowed = entitlement.paid;
  void feature;
  return { allowed, entitlement, feature };
}

export function premiumDeniedPayload(feature: PremiumFeatureId) {
  const meta = PREMIUM_FEATURE_META[feature];
  return {
    error: "premium_required",
    feature,
    title: meta?.title || feature,
    message: `ฟีเจอร์นี้สำหรับสมาชิกที่ชำระเงิน — ${meta?.description || ""}`.trim(),
  };
}
