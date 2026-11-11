/**
 * Paid / premium feature gate — build features first, enforce later.
 *
 * Phase 1 (now): feature APIs unlocked unless `PREMIUM_ENFORCE=1`.
 * Multi-template limits always apply from app_settings (admin /limits).
 * Paid users are marked by superadmin (`user.plan = pro`) until Stripe exists.
 */

import {
  DEFAULT_FREE_MAX_MULTI,
  DEFAULT_PAID_MAX_MULTI,
  getAppLimits,
  listUsersForAdmin as listUsersFromStore,
  setUserPlan as setUserPlanInStore,
} from "./admin-store";
import { getAuthPool } from "./auth-db";

export const PremiumFeature = {
  AiSourceMap: "ai_source_map",
  AiLogin: "ai_login",
  TemplateTagger: "template_tagger",
  AiTagDraft: "ai_tag_draft",
  OcrImages: "ocr_images",
  BatchFill: "batch_fill",
} as const;

export type PremiumFeatureId =
  (typeof PremiumFeature)[keyof typeof PremiumFeature];

/** Features free plan may use even when PREMIUM_ENFORCE=1 (BYOK / template tools). */
const FREE_ALWAYS_FEATURES = new Set<PremiumFeatureId>([
  PremiumFeature.AiLogin,
  PremiumFeature.TemplateTagger,
  PremiumFeature.AiTagDraft,
]);

/** @deprecated prefer getAppLimits() — kept for docs/UI defaults */
export const FREE_MAX_MULTI_TEMPLATES = DEFAULT_FREE_MAX_MULTI;
/** @deprecated prefer getAppLimits() */
export const PAID_MAX_MULTI_TEMPLATES = DEFAULT_PAID_MAX_MULTI;

export type Entitlement = {
  paid: boolean;
  plan?: "free" | "pro" | "unknown";
  customerId?: string | null;
  maxMultiTemplates: number;
};

export function roleIsStaffPaid(role: string | null | undefined): boolean {
  if (!role) return false;
  const parts = String(role)
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  return parts.some((r) => r === "admin" || r === "superadmin");
}

export function planIsPaid(plan: string | null | undefined): boolean {
  const p = String(plan || "")
    .trim()
    .toLowerCase();
  return p === "pro" || p === "paid" || p === "premium";
}

export function isPaidEntitlement(
  role: string | null | undefined,
  plan: string | null | undefined,
): boolean {
  return roleIsStaffPaid(role) || planIsPaid(plan);
}

export const PREMIUM_FEATURE_META: Record<
  PremiumFeatureId,
  { title: string; description: string }
> = {
  [PremiumFeature.AiSourceMap]: {
    title: "แมปเอกสารด้วย AI",
    description: "แนบ PDF/Word/รูป แล้วให้ Gemini เติมฟอร์ม",
  },
  [PremiumFeature.AiLogin]: {
    title: "เชื่อมต่อ AI (BYOK)",
    description: "ใส่ API key ของคุณจาก Gemini / OpenAI / Claude และเจ้าอื่น",
  },
  [PremiumFeature.TemplateTagger]: {
    title: "สร้างเทมเพลตจากเอกสาร",
    description: "ไฮไลต์ข้อความแล้วใส่ {{ตัวแปร}} คงเลย์เอาต์ Word",
  },
  [PremiumFeature.AiTagDraft]: {
    title: "AI ช่วยดราฟตัวแปร",
    description: "ส่งไฟล์ .docx ให้ AI เสนอจุดที่เป็นช่องกรอก แล้วสร้างแท็กให้อัตโนมัติ",
  },
  [PremiumFeature.OcrImages]: {
    title: "OCR รูปภาพ",
    description: "อ่านข้อความจากรูปประกอบเอกสารต้นทาง",
  },
  [PremiumFeature.BatchFill]: {
    title: "กรอกหลายไฟล์",
    description: `ฟรี/จ่ายแล้ว — ปรับได้ที่ Admin → โควตา & ลิมิต`,
  },
};

function enforceEnabled(): boolean {
  const v = String(process.env.PREMIUM_ENFORCE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function loadUserBilling(
  userId: string,
): Promise<{ role: string | null; plan: string | null; email: string | null }> {
  const pool = getAuthPool();
  const { rows } = await pool.query<{
    role: string | null;
    plan: string | null;
    email: string | null;
  }>(`SELECT role, plan, email FROM "user" WHERE id = $1 LIMIT 1`, [userId]);
  const row = rows[0];
  return {
    role: row?.role ?? null,
    plan: row?.plan ?? null,
    email: row?.email ?? null,
  };
}

async function limitForPaid(paid: boolean): Promise<number> {
  try {
    const limits = await getAppLimits();
    return paid ? limits.paidMaxMulti : limits.freeMaxMulti;
  } catch {
    return paid ? DEFAULT_PAID_MAX_MULTI : DEFAULT_FREE_MAX_MULTI;
  }
}

export async function resolveEntitlement(
  req?: Request,
): Promise<Entitlement> {
  let customerId: string | null = null;
  let role: string | null = null;
  let plan: string | null = null;
  if (req) {
    try {
      const { auth } = await import("./auth");
      const session = await auth.api.getSession({ headers: req.headers });
      customerId = session?.user?.id ?? null;
      const u = session?.user as
        | { role?: string; plan?: string }
        | undefined;
      role = u?.role ? String(u.role) : null;
      plan = u?.plan ? String(u.plan) : null;
      if (customerId) {
        try {
          const live = await loadUserBilling(customerId);
          role = live.role ?? role;
          plan = live.plan ?? plan;
        } catch (err) {
          console.warn("[premium] DB plan lookup failed, using session:", err);
        }
      }
    } catch {
      customerId = null;
      role = null;
      plan = null;
    }
  }

  const bypass = String(process.env.PREMIUM_BYPASS_KEY || "").trim();
  const headerKey = req?.headers.get("x-premium-bypass")?.trim() || "";
  if (bypass && headerKey && bypass === headerKey) {
    return {
      paid: true,
      plan: "pro",
      customerId: customerId || "bypass",
      maxMultiTemplates: await limitForPaid(true),
    };
  }

  const paid = isPaidEntitlement(role, plan);
  return {
    paid,
    plan: paid ? "pro" : "free",
    customerId,
    maxMultiTemplates: await limitForPaid(paid),
  };
}

export async function canUseFeature(
  feature: PremiumFeatureId,
  req?: Request,
): Promise<{ allowed: boolean; entitlement: Entitlement; feature: PremiumFeatureId }> {
  const entitlement = await resolveEntitlement(req);
  const allowed =
    FREE_ALWAYS_FEATURES.has(feature) || !enforceEnabled() || entitlement.paid;
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

export async function requireSuperAdmin(req: Request): Promise<
  | { ok: true; userId: string; email: string | null }
  | { ok: false; status: 401 | 403; error: string; code?: string }
> {
  try {
    const { auth } = await import("./auth");
    const session = await auth.api.getSession({ headers: req.headers });
    const userId = session?.user?.id;
    if (!userId) {
      return {
        ok: false,
        status: 401,
        error: "ต้องเข้าสู่ระบบ",
        code: "AUTH_REQUIRED",
      };
    }
    const live = await loadUserBilling(userId);
    const role =
      live.role ||
      String((session.user as { role?: string }).role || "");
    if (
      !roleIsStaffPaid(role) ||
      !String(role).toLowerCase().includes("superadmin")
    ) {
      return { ok: false, status: 403, error: "สำหรับ superadmin เท่านั้น" };
    }
    return {
      ok: true,
      userId,
      email: live.email || session.user.email || null,
    };
  } catch {
    return {
      ok: false,
      status: 401,
      error: "ต้องเข้าสู่ระบบ",
      code: "AUTH_REQUIRED",
    };
  }
}

export async function listUsersForAdmin(q?: string) {
  return listUsersFromStore({ q });
}

export async function setUserPlan(
  userId: string,
  plan: "free" | "pro",
) {
  return setUserPlanInStore(userId, plan);
}
