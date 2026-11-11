import { Hono } from "hono";
import {
  extractDocumentLayout,
  extractDocumentText,
  fillTemplate,
  formatTemplateError,
  parseTemplate,
  type FormField,
} from "./docx-engine";
import {
  ensureAdminSchema,
  getAiAdminSettings,
  getAppLimits,
  listAuditLogs,
  listUsersForAdmin,
  resolveUpgradeUrl,
  setAiAdminSettings,
  setAppLimits,
  setUserBanned,
  setUserPlan,
  setUserRole,
  writeAuditLog,
} from "./admin-store";
import {
  clearGeminiKey,
  adminDefaultProviderFromSettings,
  coalesceAiCredentialsWithSharedEnv,
  ensureAiServerConfigLoaded,
  geminiStatus,
  getGeminiApiKey,
  getRequestAiProvider,
  getRequestGeminiKey,
  hasRequestAiKey,
  isByokOnly,
  maskGeminiKey,
  missingAiCredentialsError,
  requestHasExplicitAiProvider,
  resolveEffectiveAiProvider,
  resolveProviderApiKey,
  resolveRequestAiCredentials,
  runWithSavedAiKeyAuthFallback,
  normalizeGeminiModel,
  writeAiConfig,
  type ResolvedRequestAiCredentials,
} from "./ai-config";
import {
  defaultModelForProvider,
  getAiProvider,
  listAiProvidersPublic,
  normalizeProviderModel,
  resolveEffectiveModelForProvider,
} from "./ai-providers";
import type { DocxFormValuesJson } from "./source-map";
import {
  canUseFeature,
  PremiumFeature,
  premiumDeniedPayload,
  requireSuperAdmin,
  resolveEntitlement,
  roleIsStaffPaid,
  type PremiumFeatureId,
} from "./premium";

// Heavy AI / ZIP / OCR deps are dynamic-imported inside those handlers only.
// Static import pulled pdf/AI graph into every /api/parse and made upload feel slow after batch/ZIP work.

const MAX_DOCX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_SOURCE_FILES = 12;

function isDocx(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) return true;
  const t = (file.type || "").toLowerCase();
  return (
    t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    t === "application/octet-stream"
  );
}

function summarizeFields(fields: FormField[]) {
  let text = 0;
  let image = 0;
  let list = 0;
  let bool = 0;
  let auto = 0;
  for (const f of fields) {
    if (f.type === "text") text += 1;
    else if (f.type === "image") image += 1;
    else if (f.type === "bool") bool += 1;
    else if (f.type === "auto") auto += 1;
    else list += 1;
  }
  return { text, image, list, bool, auto };
}

/** Compact log lines for what AI filled into Export JSON. */
function summarizeAiValuesJson(valuesJson: DocxFormValuesJson): string {
  const values = (valuesJson?.values || {}) as Record<string, unknown>;
  const keys = Object.keys(values);
  const filled = keys.filter((k) => {
    const v = values[k];
    if (v == null || v === "") return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
  const preview = JSON.stringify(values);
  const clipped =
    preview.length > 480 ? `${preview.slice(0, 477)}…` : preview;
  const keySample = filled.slice(0, 10).join(", ") || "(ยังไม่เต็มช่อง)";
  return `AI กรอก ${filled.length}/${keys.length} คีย์ [${keySample}] · values=${clipped}`;
}

function assertNotAborted(signal: AbortSignal | null | undefined) {
  if (signal?.aborted) {
    const err = new Error("ยกเลิกโดยผู้ใช้");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Shared AI credential gate for routes that accept X-Ai-Key-Id and/or
 * per-request keys. Resolves vault → coalesce missing id to shared env →
 * effective provider/model. Generic — no per-route special cases.
 */
async function resolveRouteAiCredentials(
  req: Request,
  extras?: {
    formKey?: string;
    formModel?: string;
    formProvider?: string;
  },
): Promise<
  | {
      ok: true;
      creds: ResolvedRequestAiCredentials;
      provider: string;
      apiKey: string;
      model: string;
    }
  | { ok: false; status: 401 | 400; error: string }
> {
  const sessionGate = await (async () => {
    try {
      const { auth } = await import("./auth");
      const session = await auth.api.getSession({ headers: req.headers });
      const userId = session?.user?.id ? String(session.user.id) : "";
      return userId ? ({ ok: true as const, userId }) : ({ ok: false as const });
    } catch {
      return { ok: false as const };
    }
  })();
  const sessionUserId = sessionGate.ok ? sessionGate.userId : null;
  let creds = await resolveRequestAiCredentials(req, sessionUserId);
  const formKey = String(extras?.formKey || "").trim();
  if (!creds.apiKey && formKey) {
    creds = {
      ...creds,
      apiKey: formKey,
      fromUserVault: false,
    };
  }
  creds = coalesceAiCredentialsWithSharedEnv(creds);
  const aiAdmin = await getAiAdminSettings().catch(() => ({
    defaultModel: "gemini-3.8-flash",
  }));
  const adminDefaultProvider = adminDefaultProviderFromSettings(aiAdmin);
  const formProvider = String(extras?.formProvider || "").trim();
  const requestedProvider =
    getAiProvider(formProvider)?.id || creds.provider;
  const provider = resolveEffectiveAiProvider({
    requestProvider: requestedProvider,
    explicitProvider:
      requestHasExplicitAiProvider(req) || Boolean(formProvider),
    requestKey: creds.apiKey,
    adminDefaultProvider,
  });
  const apiKey = resolveProviderApiKey(provider, creds.apiKey);
  const model = resolveEffectiveModelForProvider(
    provider,
    extras?.formModel || creds.model,
  );
  if (!hasRequestAiKey(provider, apiKey) || !apiKey) {
    return {
      ok: false,
      status: 401,
      error: missingAiCredentialsError(creds),
    };
  }
  // Record last-used only on real AI routes (not /ai/status).
  if (creds.fromUserVault && creds.keyId && sessionUserId) {
    void import("./ai-key-vault")
      .then(({ touchUserAiKeyUsed }) =>
        touchUserAiKeyUsed(sessionUserId, String(creds.keyId)),
      )
      .catch(() => undefined);
  }
  return {
    ok: true,
    creds: {
      ...creds,
      provider,
      apiKey,
      model,
    },
    provider,
    apiKey,
    model,
  };
}

/** Options for auth-error JSON when the shared server key was in use. */
function sharedServerKeyErrorOpts(
  creds: ResolvedRequestAiCredentials,
  providerId?: string | null,
): {
  usedSharedEnvFallback?: boolean;
  keySource?: "shared";
  providerLabel?: string;
} {
  if (!creds.usedSharedEnvFallback) return {};
  const id = String(providerId || creds.provider || "").trim();
  const label = getAiProvider(id)?.label || id || undefined;
  return {
    usedSharedEnvFallback: true,
    keySource: "shared",
    providerLabel: label,
  };
}

export function createApi(options: {
  startedAt: Date;
  version?: string;
  authorName?: string;
  authorEmail?: string;
}) {
  const api = new Hono();

  async function requirePremium(
    c: { req: { raw: Request }; json: (body: unknown, status?: number) => Response },
    feature: PremiumFeatureId,
  ): Promise<Response | null> {
    const gate = await canUseFeature(feature, c.req.raw);
    if (gate.allowed) return null;
    return c.json(premiumDeniedPayload(feature), 402);
  }

  /**
   * Same-origin avatar proxy for OAuth provider image URLs (Google, Facebook, …).
   * Avoids browser referrer / hotlink blocks that leave AuthBar on the letter fallback.
   */
  api.get("/avatar", async (c) => {
    const raw = String(c.req.query("src") || "").trim();
    if (!raw) return c.json({ error: "missing src" }, 400);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return c.json({ error: "invalid src" }, 400);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return c.json({ error: "invalid protocol" }, 400);
    }
    // Allow common IdP avatar hosts only — not an open proxy.
    const host = url.hostname.toLowerCase();
    const allowed =
      host.endsWith(".googleusercontent.com") ||
      host === "lh3.googleusercontent.com" ||
      host.endsWith(".ggpht.com") ||
      host.endsWith(".fbsbx.com") ||
      host.endsWith("facebook.com") ||
      host.endsWith("fbcdn.net") ||
      host.endsWith("githubusercontent.com") ||
      host.endsWith("discordapp.com") ||
      host.endsWith("discordcdn.com") ||
      host.endsWith("cdn.discordapp.com") ||
      host.endsWith("avatars.githubusercontent.com") ||
      host.endsWith("graph.facebook.com") ||
      host.endsWith("platform-lookaside.fbsbx.com");
    if (!allowed) return c.json({ error: "host not allowed" }, 400);

    try {
      const upstream = await fetch(url.toString(), {
        headers: {
          // IdP CDNs often 403 when Referer is our app origin.
          "User-Agent": "docx-form-avatar-proxy/1.0",
          Accept: "image/*,*/*;q=0.8",
        },
        redirect: "follow",
      });
      if (!upstream.ok) {
        return c.json({ error: `upstream ${upstream.status}` }, 502);
      }
      const ctype = upstream.headers.get("content-type") || "image/jpeg";
      if (!ctype.toLowerCase().startsWith("image/")) {
        return c.json({ error: "not an image" }, 502);
      }
      const bytes = await upstream.arrayBuffer();
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": ctype,
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  /** Current user profile + live plan/limits (for /account). */
  api.get("/me", async (c) => {
    const guest = { user: null, premium: null, session: null };
    try {
      const { auth } = await import("./auth");
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      // Guests get 200 + null user so browsers do not log a noisy 401 on boot.
      if (!session?.user) {
        return c.json(guest);
      }
      await ensureAdminSchema().catch(() => undefined);
      const ent = await resolveEntitlement(c.req.raw);
      const limits = await getAppLimits().catch(() => ({
        freeMaxMulti: 2,
        paidMaxMulti: 10,
      }));
      const u = session.user as {
        id: string;
        name?: string | null;
        email?: string | null;
        image?: string | null;
        role?: string | null;
        plan?: string | null;
        emailVerified?: boolean;
        createdAt?: string | Date;
      };
      return c.json({
        user: {
          id: u.id,
          name: u.name || null,
          email: u.email || null,
          image: u.image || null,
          role: u.role || "user",
          plan: ent.plan || u.plan || "free",
          emailVerified: Boolean(u.emailVerified),
          createdAt: u.createdAt || null,
        },
        premium: {
          paid: ent.paid,
          plan: ent.plan || "free",
          maxMultiTemplates: ent.maxMultiTemplates,
          freeMaxMulti: limits.freeMaxMulti,
          paidMaxMulti: limits.paidMaxMulti,
          upgradeUrl: resolveUpgradeUrl(limits) || "",
        },
        session: {
          id: session.session.id,
          expiresAt: session.session.expiresAt,
        },
      });
    } catch {
      // Session store unavailable — treat as logged out for this probe so the
      // guest shell does not surface a console error on every boot.
      return c.json(guest);
    }
  });

  /**
   * Public liveness / readiness — status only (no version / author / AI inventory).
   * Production missing BETTER_AUTH_SECRET → not-ready (503).
   */
  api.get("/health", async (c) => {
    const { getBetterAuthSecretHealth } = await import("./auth-secret");
    const { hasServerAiKeyConfigured } = await import("./ai-config");
    const secret = getBetterAuthSecretHealth();
    const serverAiKeyConfigured = hasServerAiKeyConfigured();
    if (!secret.ready) {
      return c.json(
        {
          ok: false,
          status: "not-ready",
          reason: "BETTER_AUTH_SECRET",
          serverAiKeyConfigured,
        },
        503,
      );
    }
    return c.json({
      ok: true,
      status: "ok",
      /** Non-secret: env/DB shared AI key present (never echoes key material). */
      serverAiKeyConfigured,
    });
  });

  /** Removed DEV test-login routes — always 404 (OIDC-only). */
  api.get("/dev/test-accounts", (c) => c.json({ error: "ไม่พบ" }, 404));
  api.post("/dev/test-login", (c) => c.json({ error: "ไม่พบ" }, 404));

  /**
   * Public plan/quota snapshot for the guest shell (no internal diagnostics).
   * Admin limit changes are reflected here for the fill UI.
   * `version` is short build commit when known (RENDER_GIT_COMMIT / SOURCE_COMMIT /
   * GIT_SHA / …), else package.json — not author / AI inventory.
   */
  api.get("/entitlement", async (c) => {
    await ensureAdminSchema().catch(() => undefined);
    const ent = await canUseFeature(PremiumFeature.AiSourceMap, c.req.raw);
    const limits = await getAppLimits().catch(() => null);
    const maxMulti = ent.entitlement.maxMultiTemplates;
    const plan = ent.entitlement.plan || "unknown";
    const paid = ent.entitlement.paid;
    const upgradeUrl = resolveUpgradeUrl(limits);
    return c.json({
      version: options.version || "0.0.0",
      premium: {
        enforce: String(process.env.PREMIUM_ENFORCE || "") === "1",
        paid,
        plan,
        maxMultiTemplates: maxMulti,
        freeMaxMulti: limits?.freeMaxMulti,
        paidMaxMulti: limits?.paidMaxMulti,
        /** Plan-aware upload quota copy for the guest/home dropzone (F02). */
        uploadLimitText: paid
          ? `สูงสุด ${maxMulti} ไฟล์ต่อครั้ง (${String(plan) === "pro" || String(plan) === "paid" || String(plan) === "premium" ? "จ่ายแล้ว" : plan})`
          : `สูงสุด ${maxMulti} ไฟล์ต่อครั้ง (ฟรี)`,
        /** F37: empty string → Frontend hides upgrade link (no hardcoded URL). */
        upgradeUrl: upgradeUrl || "",
      },
    });
  });

  /** Internal diagnostics — version, contact, uptime, AI provider details. */
  api.get("/diagnostics", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    await ensureAdminSchema().catch(() => undefined);
    let aiCreds = await resolveRequestAiCredentials(
      c.req.raw,
      gate.userId,
    );
    aiCreds = coalesceAiCredentialsWithSharedEnv(aiCreds);
    const aiAdmin = await getAiAdminSettings().catch(() => ({
      defaultModel: "gemini-3.8-flash",
    }));
    const adminDefaultProvider = adminDefaultProviderFromSettings(aiAdmin);
    return c.json({
      ok: true,
      name: "docx-form-web",
      version: options.version || "0.0.0",
      author: options.authorName || "",
      email: options.authorEmail || "",
      startedAt: options.startedAt.toISOString(),
      ai: geminiStatus({
        requestKey: aiCreds.apiKey,
        requestModel: aiCreds.model,
        requestProvider: aiCreds.provider,
        adminDefaultModel: aiAdmin.defaultModel,
        adminDefaultProvider,
        fromUserVault: Boolean(aiCreds.fromUserVault),
        keyId: aiCreds.keyId || null,
        usedSharedEnvFallback: Boolean(aiCreds.usedSharedEnvFallback),
      }),
    });
  });

  /** Superadmin: list users with live plan from Postgres */
  api.get("/admin/users", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const q = c.req.query("q") || "";
    const users = await listUsersForAdmin({ q });
    return c.json({ users });
  });

  /** Superadmin: set free|pro */
  api.post("/admin/plan", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: string;
      plan?: string;
    };
    const userId = String(body.userId || "").trim();
    const planRaw = String(body.plan || "")
      .trim()
      .toLowerCase();
    const plan = planRaw === "pro" ? "pro" : planRaw === "free" ? "free" : null;
    if (!userId || !plan) {
      return c.json({ error: "ต้องส่ง userId และ plan=free|pro" }, 400);
    }
    const updated = await setUserPlan(userId, plan);
    if (!updated) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
    await writeAuditLog({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: "user.plan",
      targetId: userId,
      targetEmail: updated.email,
      detail: { plan },
    });
    return c.json({
      ok: true,
      user: {
        id: userId,
        email: updated.email,
        role: updated.role,
        plan: updated.plan,
      },
    });
  });

  api.post("/admin/role", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: string;
      role?: string;
    };
    const userId = String(body.userId || "").trim();
    const role = String(body.role || "")
      .trim()
      .toLowerCase();
    if (!userId || !role) {
      return c.json({ error: "ต้องส่ง userId และ role" }, 400);
    }
    if (userId === gate.userId && role !== "superadmin") {
      return c.json({ error: "ห้ามลด role ของตัวเอง" }, 400);
    }
    const updated = await setUserRole(userId, role);
    if (!updated) {
      return c.json({ error: "role ต้องเป็น user|admin|superadmin" }, 400);
    }
    await writeAuditLog({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: "user.role",
      targetId: userId,
      targetEmail: updated.email,
      detail: { role: updated.role },
    });
    return c.json({ ok: true, user: { id: userId, ...updated } });
  });

  api.post("/admin/ban", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      userId?: string;
      banned?: boolean;
      banReason?: string;
    };
    const userId = String(body.userId || "").trim();
    if (!userId || typeof body.banned !== "boolean") {
      return c.json({ error: "ต้องส่ง userId และ banned" }, 400);
    }
    if (userId === gate.userId) {
      return c.json({ error: "ห้ามแบนตัวเอง" }, 400);
    }
    const updated = await setUserBanned(userId, body.banned, body.banReason);
    if (!updated) return c.json({ error: "ไม่พบผู้ใช้" }, 404);
    await writeAuditLog({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: body.banned ? "user.ban" : "user.unban",
      targetId: userId,
      targetEmail: updated.email,
      detail: { banned: updated.banned, banReason: updated.banReason },
    });
    return c.json({ ok: true, user: { id: userId, ...updated } });
  });

  api.get("/admin/limits", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const limits = await getAppLimits();
    return c.json({
      limits,
      upgradeUrl: resolveUpgradeUrl(limits) || "",
    });
  });

  api.post("/admin/limits", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      freeMaxMulti?: number;
      paidMaxMulti?: number;
      upgradeUrl?: string;
    };
    const limits = await setAppLimits({
      freeMaxMulti: body.freeMaxMulti,
      paidMaxMulti: body.paidMaxMulti,
      ...(body.upgradeUrl !== undefined ? { upgradeUrl: body.upgradeUrl } : {}),
    });
    await writeAuditLog({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: "limits.update",
      detail: { ...limits, upgradeUrl: limits.upgradeUrl || "" },
    });
    return c.json({
      ok: true,
      limits,
      upgradeUrl: resolveUpgradeUrl(limits) || "",
    });
  });

  api.get("/admin/ai", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    await ensureAiServerConfigLoaded().catch(() => undefined);
    const aiAdmin = await getAiAdminSettings();
    const adminDefaultProvider = adminDefaultProviderFromSettings(aiAdmin);
    const status = geminiStatus({
      adminDefaultModel: aiAdmin.defaultModel,
      adminDefaultProvider,
    });
    // Strip internals — never leak env var names, filesystem paths, or raw
    // configPath. Human labels only; effective* matches /ai/status pill resolver.
    // Server keys: status.serverKeySources from the provider catalog (generic).
    const {
      configPath: _dropPath,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ...safeStatus
    } = status as typeof status & { configPath?: string };
    void _dropPath;
    return c.json({
      settings: aiAdmin,
      status: {
        ...safeStatus,
        effectiveProvider: status.effectiveProvider,
        effectiveProviderLabel: status.effectiveProviderLabel,
        effectiveModel: status.effectiveModel || status.model,
        model: status.model,
        adminDefaultModel: status.adminDefaultModel,
        adminDefaultProvider: status.adminDefaultProvider,
        defaultModel: status.defaultModel,
        configStoreLabel: status.configStoreLabel,
        serverKeySources: status.serverKeySources || [],
        hasClearableServerKey: Boolean(status.hasClearableServerKey),
        premiumEnforceLabel: status.premiumEnforce
          ? "บังคับแผนพรีเมียม"
          : "ไม่บังคับ",
      },
    });
  });

  api.post("/admin/ai", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      defaultModel?: string;
    };
    const model = normalizeGeminiModel(body.defaultModel);
    if (!model) return c.json({ error: "โมเดลไม่ถูกต้อง" }, 400);
    const settings = await setAiAdminSettings({ defaultModel: model });
    if (!isByokOnly()) {
      await writeAiConfig({ geminiModel: model });
    }
    await writeAuditLog({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: "ai.settings",
      detail: settings,
    });
    const adminDefaultProvider = adminDefaultProviderFromSettings(settings);
    const status = geminiStatus({
      adminDefaultModel: settings.defaultModel,
      adminDefaultProvider,
    });
    const { configPath: _dropPath, ...safeStatus } = status as typeof status & {
      configPath?: string;
    };
    void _dropPath;
    return c.json({
      ok: true,
      settings,
      status: {
        ...safeStatus,
        premiumEnforceLabel: status.premiumEnforce
          ? "บังคับแผนพรีเมียม"
          : "ไม่บังคับ",
        effectiveModel: status.effectiveModel || status.model,
      },
    });
  });

  /** Superadmin-only: clear file-stored server Gemini key (not env keys). */
  api.delete("/admin/ai/server-key", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    if (isByokOnly()) {
      return c.json(
        { error: "โหมด BYOK ไม่มีการเก็บคีย์บนเซิร์ฟเวอร์ให้ลบ" },
        400,
      );
    }
    await clearGeminiKey();
    await writeAuditLog({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: "ai.clear_server_key",
      detail: { kind: "db-gemini" },
    });
    const aiAdmin = await getAiAdminSettings();
    return c.json({
      ok: true,
      cleared: true,
      status: geminiStatus({
        adminDefaultModel: aiAdmin.defaultModel,
        adminDefaultProvider: adminDefaultProviderFromSettings(aiAdmin),
      }),
    });
  });

  api.get("/admin/audit", async (c) => {
    const gate = await requireSuperAdmin(c.req.raw);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const limit = Number(c.req.query("limit") || 100);
    const rows = await listAuditLogs(limit);
    return c.json({ rows });
  });

  api.get("/ai/providers", async (c) => {
    const aiAdmin = await getAiAdminSettings().catch(() => ({
      defaultModel: "gemini-3.8-flash",
    }));
    const adminDefaultProvider = adminDefaultProviderFromSettings(aiAdmin);
    const defaultProvider = resolveEffectiveAiProvider({
      requestProvider: getRequestAiProvider(c.req.raw),
      explicitProvider: requestHasExplicitAiProvider(c.req.raw),
      requestKey: getRequestGeminiKey(c.req.raw),
      adminDefaultProvider,
    });
    return c.json({
      providers: listAiProvidersPublic(),
      defaultProvider,
      adminDefaultProvider,
    });
  });

  api.get("/ai/jobs/:id", async (c) => {
    const { getAiJob } = await import("./ai-jobs");
    const job = getAiJob(c.req.param("id"));
    if (!job) return c.json({ error: "ไม่พบงาน" }, 404);
    const gate = await requireSessionUserId(c.req.raw);
    if (
      job.ownerUserId &&
      (!gate.ok || gate.userId !== job.ownerUserId)
    ) {
      return c.json({ error: "ไม่มีสิทธิ์" }, 403);
    }
    return c.json(job);
  });

  api.delete("/ai/jobs/:id", async (c) => {
    const { cancelAiJob } = await import("./ai-jobs");
    const gate = await requireSessionUserId(c.req.raw);
    const ownerUserId = gate.ok ? gate.userId : null;
    const ok = cancelAiJob(c.req.param("id"), ownerUserId);
    if (!ok) return c.json({ error: "ไม่พบงานหรือไม่มีสิทธิ์" }, 404);
    return c.json({ ok: true });
  });

  /** Live model list for a provider (needs the user's API key). */
  api.post("/ai/models", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        provider?: string;
        apiKey?: string;
      };
      const provider =
        getAiProvider(body.provider)?.id ||
        getRequestAiProvider(c.req.raw) ||
        "google";
      const apiKey =
        String(body.apiKey || "").trim() ||
        getRequestGeminiKey(c.req.raw) ||
        "";
      if (!apiKey) {
        return c.json({ error: "ต้องส่ง apiKey เพื่อดึงรายการโมเดล" }, 400);
      }
      const { listProviderModels } = await import("./ai-models-list");
      const result = await listProviderModels({ provider, apiKey });
      return c.json({
        ok: true,
        provider,
        providerLabel: result.providerLabel,
        models: result.models,
        defaultModel: result.defaultModel,
        source: result.source,
        warning: result.error || null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  api.get("/ai/status", async (c) => {
    const aiAdmin = await getAiAdminSettings().catch(() => ({
      defaultModel: "gemini-3.8-flash",
    }));
    // Resolve X-Ai-Key-Id → vault secret when the user is logged in (AI8).
    let sessionUserId: string | null = null;
    try {
      const { auth } = await import("./auth");
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      sessionUserId = session?.user?.id ? String(session.user.id) : null;
    } catch {
      sessionUserId = null;
    }
    const { resolveRequestAiCredentials, coalesceAiCredentialsWithSharedEnv } =
      await import("./ai-config");
    let creds = await resolveRequestAiCredentials(c.req.raw, sessionUserId);
    creds = coalesceAiCredentialsWithSharedEnv(creds);
    let lastTestAt: string | null = null;
    let lastTestOk: boolean | null = null;
    let lastTestCode: string | null = null;
    let lastTestMessage: string | null = null;
    if (creds.fromUserVault && creds.keyId && sessionUserId) {
      try {
        const { getUserAiKey } = await import("./ai-key-vault");
        const row = await getUserAiKey(sessionUserId, creds.keyId);
        if (row) {
          lastTestAt = row.lastTestAt || null;
          lastTestOk =
            typeof row.lastTestOk === "boolean" ? row.lastTestOk : null;
          lastTestCode = row.lastTestCode || null;
          lastTestMessage = row.lastTestMessage || null;
        }
      } catch {
        /* ignore vault meta errors for status */
      }
    }
    const adminDefaultProvider = adminDefaultProviderFromSettings(aiAdmin);
    const status = geminiStatus({
      requestKey: creds.apiKey,
      requestModel: creds.model,
      requestProvider: creds.provider,
      explicitProvider: requestHasExplicitAiProvider(c.req.raw),
      adminDefaultModel: aiAdmin.defaultModel,
      adminDefaultProvider,
      fromUserVault: Boolean(creds.fromUserVault),
      keyId: creds.keyId || null,
      usedSharedEnvFallback: Boolean(creds.usedSharedEnvFallback),
      lastTestAt,
      lastTestOk,
      lastTestCode,
      lastTestMessage,
    });
    // Never leak filesystem paths on the public status endpoint.
    const { configPath: _drop, ...safe } = status as typeof status & {
      configPath?: string;
    };
    void _drop;
    const limits = await getAppLimits().catch(() => null);
    return c.json({
      ...safe,
      /** F37: empty → hide upgrade CTA (no hardcoded URL). */
      upgradeUrl: resolveUpgradeUrl(limits) || "",
    });
  });

  const postAiConnect = async (c: Parameters<typeof requirePremium>[0] & {
    req: { json: () => Promise<unknown> };
  }) => {
    const denied = await requirePremium(c, PremiumFeature.AiLogin);
    if (denied) return denied;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        apiKey?: string;
        model?: string;
        provider?: string;
        /** Legacy: persist on server (disabled when BYOK-only) */
        persist?: boolean;
      };
      const provider =
        getAiProvider(body.provider)?.id ||
        getRequestAiProvider(c.req.raw) ||
        "google";
      const key = String(body.apiKey || "").trim();
      const model =
        normalizeProviderModel(provider, body.model) ||
        defaultModelForProvider(provider);

      const minLen = provider === "google" ? 20 : 8;
      if (key && key.length < minLen) {
        const label = getAiProvider(provider)?.label || "AI";
        return c.json({ error: `กรุณาใส่ ${label} API key ที่ถูกต้อง` }, 400);
      }
      if (!key && !model) {
        return c.json({ error: "ส่ง apiKey และ/หรือ model" }, 400);
      }

      if (isByokOnly() || body.persist === false) {
        if (!key && !getRequestGeminiKey(c.req.raw)) {
          return c.json(
            {
              error:
                "ต้องส่ง API key ของคุณ (เก็บในเบราว์เซอร์ ไม่บันทึกลงเซิร์ฟเวอร์)",
            },
            400,
          );
        }
        const effectiveKey = key || getRequestGeminiKey(c.req.raw) || "";
        return c.json({
          ok: true,
          ...geminiStatus({
            requestKey: effectiveKey,
            requestModel: model,
            requestProvider: provider,
          }),
          maskedKey: maskGeminiKey(effectiveKey),
          connected: true,
          byok: true,
        });
      }

      if (provider !== "google") {
        return c.json(
          {
            error:
              "โหมดเซิร์ฟเวอร์รองรับเฉพาะ Gemini — เปิด BYOK หรือใช้ provider=google",
          },
          400,
        );
      }
      const patch: { geminiApiKey?: string; geminiModel?: string } = {};
      if (key) patch.geminiApiKey = key;
      if (model) patch.geminiModel = model;
      if (patch.geminiModel && !patch.geminiApiKey && !getGeminiApiKey()) {
        return c.json({ error: "ต้องเชื่อมต่อ API key ก่อนเปลี่ยนโมเดล" }, 401);
      }
      await writeAiConfig(patch);
      return c.json({ ok: true, ...geminiStatus({ requestProvider: "google" }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  };

  api.post("/ai/connect", (c) => postAiConnect(c));
  api.post("/ai/google", (c) => postAiConnect(c));

  const deleteAiConnect = async (c: Parameters<typeof requirePremium>[0]) => {
    // Clearing the shared DB-stored server key is superadmin-only.
    // BYOK mode is a no-op clear (client-side disconnect status only).
    if (!isByokOnly()) {
      const gate = await requireSuperAdmin(c.req.raw);
      if (!gate.ok) return c.json({ error: gate.error }, gate.status);
      await clearGeminiKey();
      await writeAuditLog({
        actorId: gate.userId,
        actorEmail: gate.email,
        action: "ai.clear_server_key",
        detail: { kind: "db-gemini", via: "ai/connect" },
      });
    }
    return c.json({
      ok: true,
      ...geminiStatus(),
      connected: false,
      byok: isByokOnly(),
    });
  };
  api.delete("/ai/google", (c) => deleteAiConnect(c));
  api.delete("/ai/connect", (c) => deleteAiConnect(c));

  async function requireSessionUserId(req: Request): Promise<
    | { ok: true; userId: string }
    | { ok: false; status: 401 | 500; error: string; code?: string }
  > {
    try {
      const { auth } = await import("./auth");
      const session = await auth.api.getSession({ headers: req.headers });
      const userId = session?.user?.id ? String(session.user.id) : "";
      if (!userId) {
        return {
          ok: false,
          status: 401,
          error: "ต้องเข้าสู่ระบบก่อน",
          code: "AUTH_REQUIRED",
        };
      }
      return { ok: true, userId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 500, error: message };
    }
  }

  /**
   * Logged-in user: list AI keys stored on server (masked meta only).
   * Never returns plaintext secrets — use X-Ai-Key-Id on AI calls to proxy.
   */
  api.get("/ai/keys", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        {
          error: gate.error,
          code: gate.code || "AUTH_REQUIRED",
        },
        gate.status,
      );
    }
    try {
      const { listUserAiKeysPublic } = await import("./ai-key-vault");
      const entries = await listUserAiKeysPublic(gate.userId);
      return c.json({ entries });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "AI_KEY_SERVER_ERROR" }, 500);
    }
  });

  /** Own audit trail (create/test/replace/delete/use) — never includes key values. */
  api.get("/ai/keys/audit", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    try {
      const { listUserAiKeyAudit, isValidUserAiKeyId } = await import(
        "./ai-key-vault"
      );
      const keyId = String(c.req.query("keyId") || "").trim();
      if (keyId && !isValidUserAiKeyId(keyId)) {
        return c.json(
          { error: "id ไม่ถูกต้อง", code: "AI_KEY_INVALID_ID" },
          400,
        );
      }
      const limit = Number(c.req.query("limit") || 50);
      const events = await listUserAiKeyAudit(gate.userId, {
        keyId: keyId || undefined,
        limit,
      });
      return c.json({ events });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "AI_KEY_SERVER_ERROR" }, 500);
    }
  });

  /** Live-validate before persist (F30). Rejected keys are never stored. */
  const rejectInvalidAiKey = async (opts: {
    provider: string;
    apiKey: string;
    signal?: AbortSignal;
  }) => {
    const { validateAiKeyForSave } = await import("./ai-key-test");
    const probe = await validateAiKeyForSave({
      provider: opts.provider,
      apiKey: opts.apiKey,
      signal: opts.signal,
    });
    if (probe.ok) return null;
    return {
      error: probe.message,
      code: probe.code || "AI_KEY_INVALID",
      ok: false as const,
      provider: probe.provider,
      durationMs: probe.durationMs,
    };
  };

  /** Create one key (auto-id if omitted). Validates with a live provider probe first. */
  api.post("/ai/keys", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        id?: string;
        provider?: string;
        label?: string;
        model?: string;
        apiKey?: string;
      };
      const apiKey = String(body.apiKey || "").trim();
      const providerRaw = String(body.provider || "google").trim();
      const provider = getAiProvider(providerRaw)?.id;
      if (!provider) {
        return c.json(
          {
            error: "ผู้ให้บริการไม่รองรับ",
            code: "AI_KEY_INVALID_PROVIDER",
          },
          400,
        );
      }
      const minLen = provider === "google" ? 20 : 8;
      if (!apiKey || apiKey.length < minLen) {
        return c.json(
          {
            error: "กรุณาใส่ API key ที่ถูกต้อง",
            code: "AI_KEY_INVALID_VALUE",
          },
          400,
        );
      }
      const rejected = await rejectInvalidAiKey({
        provider,
        apiKey,
        signal: c.req.raw.signal,
      });
      if (rejected) {
        return c.json(rejected, rejected.code === "AI_PROVIDER_TIMEOUT" ? 504 : 400);
      }
      const { createUserAiKey, toPublicAiKey } = await import("./ai-key-vault");
      const saved = await createUserAiKey(gate.userId, {
        id: body.id,
        provider,
        label: String(body.label || "").trim(),
        model: String(body.model || "").trim(),
        apiKey,
      });
      return c.json({ ok: true, entry: toPublicAiKey(saved) }, 201);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code || "")
          : "";
      if (code === "AI_KEY_EXISTS") {
        return c.json(
          { error: "มีคีย์ id นี้แล้ว", code: "AI_KEY_EXISTS" },
          400,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      if (/id ไม่ถูกต้อง/.test(message)) {
        return c.json({ error: message, code: "AI_KEY_INVALID_ID" }, 400);
      }
      return c.json({ error: message, code: "AI_KEY_MISSING_FIELDS" }, 400);
    }
  });

  /** Upsert one or many keys the user opted to sync (compat with existing clients). */
  api.put("/ai/keys", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        entries?: Array<{
          id?: string;
          provider?: string;
          label?: string;
          model?: string;
          apiKey?: string;
        }>;
        entry?: {
          id?: string;
          provider?: string;
          label?: string;
          model?: string;
          apiKey?: string;
        };
      };
      const rawList = Array.isArray(body.entries)
        ? body.entries
        : body.entry
          ? [body.entry]
          : [];
      if (!rawList.length) {
        return c.json(
          {
            error: "ต้องส่ง entry หรือ entries",
            code: "AI_KEY_MISSING_FIELDS",
          },
          400,
        );
      }
      const normalized = rawList.map((e) => ({
        id: String(e.id || "").trim(),
        provider: String(e.provider || "google").trim(),
        label: String(e.label || "").trim(),
        model: String(e.model || "").trim(),
        apiKey: String(e.apiKey || "").trim(),
      }));
      // Validate every key before writing any — reject does not store.
      for (const e of normalized) {
        const provider = getAiProvider(e.provider)?.id;
        if (!provider) {
          return c.json(
            {
              error: "ผู้ให้บริการไม่รองรับ",
              code: "AI_KEY_INVALID_PROVIDER",
            },
            400,
          );
        }
        e.provider = provider;
        if (!e.apiKey || e.apiKey.length < 8) {
          return c.json(
            {
              error: "กรุณาใส่ API key ที่ถูกต้อง",
              code: "AI_KEY_INVALID_VALUE",
            },
            400,
          );
        }
        const rejected = await rejectInvalidAiKey({
          provider,
          apiKey: e.apiKey,
          signal: c.req.raw.signal,
        });
        if (rejected) {
          return c.json(
            rejected,
            rejected.code === "AI_PROVIDER_TIMEOUT" ? 504 : 400,
          );
        }
      }
      const { upsertUserAiKeys, toPublicAiKey } = await import("./ai-key-vault");
      const saved = await upsertUserAiKeys(gate.userId, normalized);
      return c.json({
        ok: true,
        entries: saved.map((e) => toPublicAiKey(e)),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "AI_KEY_MISSING_FIELDS" }, 400);
    }
  });

  /** Test a plaintext key before save (does not persist). */
  api.post("/ai/keys/test", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        provider?: string;
        apiKey?: string;
        timeoutMs?: number;
      };
      const { testAiProviderKey } = await import("./ai-key-test");
      const result = await testAiProviderKey({
        provider: String(body.provider || "google"),
        apiKey: String(body.apiKey || ""),
        timeoutMs: body.timeoutMs,
        signal: c.req.raw.signal,
      });
      return c.json(
        result,
        result.ok
          ? 200
          : result.code === "AI_KEY_TEST_TIMEOUT" ||
              result.code === "AI_PROVIDER_TIMEOUT"
            ? 504
            : 400,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "AI_PROVIDER_ERROR", ok: false }, 400);
    }
  });

  api.get("/ai/keys/:id", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    const id = String(c.req.param("id") || "").trim();
    const { getUserAiKey, isValidUserAiKeyId, toPublicAiKey } = await import(
      "./ai-key-vault"
    );
    if (!isValidUserAiKeyId(id)) {
      return c.json({ error: "id ไม่ถูกต้อง", code: "AI_KEY_INVALID_ID" }, 400);
    }
    const row = await getUserAiKey(gate.userId, id);
    if (!row) {
      return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
    }
    return c.json({ entry: toPublicAiKey(row) });
  });

  /** Replace / rotate the secret (and optional label/model/provider) of a saved key. */
  api.put("/ai/keys/:id", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    const id = String(c.req.param("id") || "").trim();
    const { isValidUserAiKeyId, replaceUserAiKey, toPublicAiKey } = await import(
      "./ai-key-vault"
    );
    if (!isValidUserAiKeyId(id)) {
      return c.json({ error: "id ไม่ถูกต้อง", code: "AI_KEY_INVALID_ID" }, 400);
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        apiKey?: string;
        provider?: string;
        label?: string;
        model?: string;
      };
      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey || apiKey.length < 8) {
        return c.json(
          {
            error: "กรุณาใส่ API key ที่ถูกต้อง",
            code: "AI_KEY_INVALID_VALUE",
          },
          400,
        );
      }
      if (body.provider && !getAiProvider(body.provider)) {
        return c.json(
          {
            error: "ผู้ให้บริการไม่รองรับ",
            code: "AI_KEY_INVALID_PROVIDER",
          },
          400,
        );
      }
      // Resolve provider for the probe (body override or existing row).
      const existing = await (async () => {
        const { getUserAiKey } = await import("./ai-key-vault");
        return getUserAiKey(gate.userId, id);
      })();
      if (!existing) {
        return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
      }
      const providerForProbe =
        (body.provider && getAiProvider(body.provider)?.id) ||
        existing.provider ||
        "google";
      const rejected = await rejectInvalidAiKey({
        provider: providerForProbe,
        apiKey,
        signal: c.req.raw.signal,
      });
      if (rejected) {
        return c.json(
          rejected,
          rejected.code === "AI_PROVIDER_TIMEOUT" ? 504 : 400,
        );
      }
      const saved = await replaceUserAiKey(gate.userId, id, {
        apiKey,
        provider: body.provider,
        label: body.label,
        model: body.model,
      });
      if (!saved) {
        return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
      }
      return c.json({ ok: true, entry: toPublicAiKey(saved) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "AI_KEY_MISSING_FIELDS" }, 400);
    }
  });

  /** Test a saved vault key; updates last-test status + audit. */
  api.post("/ai/keys/:id/test", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    const id = String(c.req.param("id") || "").trim();
    const {
      getUserAiKey,
      isValidUserAiKeyId,
      updateUserAiKeyTestResult,
      toPublicAiKey,
    } = await import("./ai-key-vault");
    if (!isValidUserAiKeyId(id)) {
      return c.json({ error: "id ไม่ถูกต้อง", code: "AI_KEY_INVALID_ID" }, 400);
    }
    const row = await getUserAiKey(gate.userId, id);
    if (!row) {
      return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      timeoutMs?: number;
    };
    const { testAiProviderKey } = await import("./ai-key-test");
    const result = await testAiProviderKey({
      provider: row.provider,
      apiKey: row.apiKey,
      timeoutMs: body.timeoutMs,
      signal: c.req.raw.signal,
    });
    const updated = await updateUserAiKeyTestResult(gate.userId, id, {
      ok: result.ok,
      code: result.code,
      message: result.message,
    });
    return c.json(
      {
        ...result,
        entry: updated ? toPublicAiKey(updated) : null,
      },
      result.ok
        ? 200
        : result.code === "AI_KEY_TEST_TIMEOUT" ||
            result.code === "AI_PROVIDER_TIMEOUT"
          ? 504
          : 400,
    );
  });

  api.delete("/ai/keys/:id", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    const id = String(c.req.param("id") || "").trim();
    const { deleteUserAiKey, isValidUserAiKeyId } = await import(
      "./ai-key-vault"
    );
    if (!isValidUserAiKeyId(id)) {
      return c.json({ error: "id ไม่ถูกต้อง", code: "AI_KEY_INVALID_ID" }, 400);
    }
    try {
      // Ownership enforced in SQL (userId = session). Other users' ids → 404
      // with no existence leak.
      const removed = await deleteUserAiKey(gate.userId, id);
      if (!removed) {
        return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
      }
      return c.json({ ok: true, removed: true, code: "AI_KEY_DELETED" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "AI_KEY_SERVER_ERROR" }, 500);
    }
  });

  // Singular aliases from FIXES.md §9 — operate on one key via ?id= or body.id.
  api.get("/ai/key", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    const { listUserAiKeysPublic, getUserAiKey, toPublicAiKey, isValidUserAiKeyId } =
      await import("./ai-key-vault");
    const id = String(c.req.query("id") || "").trim();
    if (id) {
      if (!isValidUserAiKeyId(id)) {
        return c.json({ error: "id ไม่ถูกต้อง", code: "AI_KEY_INVALID_ID" }, 400);
      }
      const row = await getUserAiKey(gate.userId, id);
      if (!row) {
        return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
      }
      return c.json({ entry: toPublicAiKey(row), connected: true });
    }
    const entries = await listUserAiKeysPublic(gate.userId);
    const entry = entries[0] || null;
    return c.json({
      entry,
      connected: Boolean(entry?.hasKey),
      entries,
    });
  });

  api.put("/ai/key", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        id?: string;
        provider?: string;
        label?: string;
        model?: string;
        apiKey?: string;
      };
      const apiKey = String(body.apiKey || "").trim();
      const provider = getAiProvider(body.provider || "google")?.id;
      if (!provider) {
        return c.json(
          {
            error: "ผู้ให้บริการไม่รองรับ",
            code: "AI_KEY_INVALID_PROVIDER",
          },
          400,
        );
      }
      if (!apiKey || apiKey.length < 8) {
        return c.json(
          {
            error: "กรุณาใส่ API key ที่ถูกต้อง",
            code: "AI_KEY_INVALID_VALUE",
          },
          400,
        );
      }
      const rejected = await rejectInvalidAiKey({
        provider,
        apiKey,
        signal: c.req.raw.signal,
      });
      if (rejected) {
        return c.json(
          rejected,
          rejected.code === "AI_PROVIDER_TIMEOUT" ? 504 : 400,
        );
      }
      const {
        createUserAiKey,
        replaceUserAiKey,
        listUserAiKeys,
        toPublicAiKey,
      } = await import("./ai-key-vault");
      const id = String(body.id || "").trim();
      let saved;
      if (id) {
        saved = await replaceUserAiKey(gate.userId, id, {
          apiKey,
          provider,
          label: body.label,
          model: body.model,
        });
        if (!saved) {
          saved = await createUserAiKey(gate.userId, {
            id,
            provider,
            label: String(body.label || "").trim(),
            model: String(body.model || "").trim(),
            apiKey,
          });
        }
      } else {
        const existing = await listUserAiKeys(gate.userId);
        if (existing[0]) {
          saved = await replaceUserAiKey(gate.userId, existing[0].id, {
            apiKey,
            provider,
            label: body.label,
            model: body.model,
          });
        } else {
          saved = await createUserAiKey(gate.userId, {
            provider,
            label: String(body.label || "").trim(),
            model: String(body.model || "").trim(),
            apiKey,
          });
        }
      }
      if (!saved) {
        return c.json({ error: "บันทึกคีย์ไม่สำเร็จ", code: "AI_KEY_SERVER_ERROR" }, 500);
      }
      return c.json({ ok: true, entry: toPublicAiKey(saved) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: "AI_KEY_MISSING_FIELDS" }, 400);
    }
  });

  api.post("/ai/key/test", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      provider?: string;
      apiKey?: string;
      timeoutMs?: number;
    };
    const id = String(body.id || c.req.query("id") || "").trim();
    if (id) {
      // Reuse saved-key test path.
      const {
        getUserAiKey,
        isValidUserAiKeyId,
        updateUserAiKeyTestResult,
        toPublicAiKey,
      } = await import("./ai-key-vault");
      if (!isValidUserAiKeyId(id)) {
        return c.json({ error: "id ไม่ถูกต้อง", code: "AI_KEY_INVALID_ID" }, 400);
      }
      const row = await getUserAiKey(gate.userId, id);
      if (!row) {
        return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
      }
      const { testAiProviderKey } = await import("./ai-key-test");
      const result = await testAiProviderKey({
        provider: row.provider,
        apiKey: row.apiKey,
        timeoutMs: body.timeoutMs,
        signal: c.req.raw.signal,
      });
      const updated = await updateUserAiKeyTestResult(gate.userId, id, {
        ok: result.ok,
        code: result.code,
        message: result.message,
      });
      return c.json(
        { ...result, entry: updated ? toPublicAiKey(updated) : null },
        result.ok ? 200 : result.code === "AI_KEY_TEST_TIMEOUT" ? 504 : 400,
      );
    }
    const { testAiProviderKey } = await import("./ai-key-test");
    const result = await testAiProviderKey({
      provider: String(body.provider || "google"),
      apiKey: String(body.apiKey || ""),
      timeoutMs: body.timeoutMs,
      signal: c.req.raw.signal,
    });
    return c.json(
      result,
      result.ok ? 200 : result.code === "AI_KEY_TEST_TIMEOUT" ? 504 : 400,
    );
  });

  api.delete("/ai/key", async (c) => {
    const gate = await requireSessionUserId(c.req.raw);
    if (!gate.ok) {
      return c.json(
        { error: gate.error, code: "AI_KEY_UNAUTHORIZED" },
        gate.status,
      );
    }
    const {
      deleteUserAiKey,
      isValidUserAiKeyId,
      listUserAiKeys,
    } = await import("./ai-key-vault");
    let id = String(c.req.query("id") || "").trim();
    if (!id) {
      const body = (await c.req.json().catch(() => ({}))) as { id?: string };
      id = String(body.id || "").trim();
    }
    if (!id) {
      const entries = await listUserAiKeys(gate.userId);
      id = entries[0]?.id || "";
    }
    if (!id || !isValidUserAiKeyId(id)) {
      return c.json(
        { error: id ? "id ไม่ถูกต้อง" : "ไม่พบคีย์", code: id ? "AI_KEY_INVALID_ID" : "AI_KEY_NOT_FOUND" },
        id ? 400 : 404,
      );
    }
    const removed = await deleteUserAiKey(gate.userId, id);
    if (!removed) {
      return c.json({ error: "ไม่พบคีย์", code: "AI_KEY_NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, removed: true, code: "AI_KEY_DELETED" });
  });

  api.post("/parse", async (c) => {
    try {
      const contentLength = Number(c.req.header("content-length") || 0);
      // Multipart overhead is small vs 25MB — reject clearly oversized bodies early.
      if (contentLength > MAX_DOCX_BYTES + 1024 * 1024) {
        return c.json({ error: "ไฟล์ใหญ่เกินไป (สูงสุด 25 MB)" }, 400);
      }

      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "กรุณาอัปโหลดไฟล์ .docx" }, 400);
      }
      if (!isDocx(file)) {
        return c.json(
          {
            error:
              file.name.toLowerCase().endsWith(".doc")
                ? "รองรับเฉพาะ .docx — ให้ Save As เป็น .docx ใน Word ก่อน"
                : "ไฟล์ต้องเป็น .docx เท่านั้น",
          },
          400,
        );
      }
      if (file.size > MAX_DOCX_BYTES) {
        return c.json({ error: "ไฟล์ใหญ่เกินไป (สูงสุด 25 MB)" }, 400);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const includeContent =
        String(form.get("includeContent") || "").toLowerCase() === "1" ||
        String(form.get("includeContent") || "").toLowerCase() === "true";

      const parsed = await parseTemplate(buffer);
      const { fields } = parsed;
      const warnings = parsed.warnings || [];

      if (fields.length === 0) {
        return c.json(
          {
            error:
              "ไม่พบตัวแปรในเทมเพลต — เปิดโหมดสร้างเทมเพลตจากเอกสารนี้เพื่อใส่ {{ตัวแปร}} หรือใส่แท็กใน Word แล้วอัปโหลดใหม่",
            code: "NO_VARIABLES",
            suggestTagger: true,
            fields: [],
            filename: file.name,
          },
          400,
        );
      }

      const payload: Record<string, unknown> = {
        filename: file.name,
        fields,
        summary: summarizeFields(fields),
      };
      if (warnings.length) payload.warnings = warnings;

      if (includeContent) {
        const layout = await extractDocumentLayout(buffer);
        payload.layout = layout.blocks;
        payload.content = await extractDocumentText(buffer);
        payload.contentIncluded = true;
      } else {
        payload.contentIncluded = false;
      }

      return c.json(payload);
    } catch (err) {
      const message = formatTemplateError(err);
      return c.json({ error: message.startsWith("อ่านเทมเพลต") ? message : `อ่านเทมเพลตไม่สำเร็จ: ${message}` }, 400);
    }
  });

  api.post("/source-map", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.AiSourceMap);
    if (denied) return denied;

    const routed = await resolveRouteAiCredentials(c.req.raw);
    if (!routed.ok) {
      return c.json({ error: routed.error }, routed.status);
    }
    const {
      creds: aiCreds,
      provider: clientProvider,
      apiKey: clientKey,
      model: clientModel,
    } = routed;

    const wantStream =
      c.req.query("stream") === "1" ||
      (c.req.header("accept") || "").includes("application/x-ndjson");

    try {
      const form = await c.req.formData();
      const fieldsRaw = form.get("fields");
      if (typeof fieldsRaw !== "string") {
        return c.json({ error: "ต้องส่ง fields เป็น JSON ของฟิลด์เทมเพลต" }, 400);
      }

      let fields: FormField[];
      try {
        const parsed = JSON.parse(fieldsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return c.json({ error: "fields ต้องเป็นอาร์เรย์ของฟิลด์ที่ไม่ว่าง" }, 400);
        }
        fields = parsed as FormField[];
      } catch {
        return c.json({ error: "fields ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }

      const seen = new Set<File>();
      const files: File[] = [];
      const pushFile = (val: FormDataEntryValue | null) => {
        if (!(val instanceof File) || seen.has(val)) return;
        seen.add(val);
        files.push(val);
      };
      for (const val of form.getAll("files")) pushFile(val);
      for (const [key, val] of form.entries()) {
        if (key === "files") continue;
        if (key === "file" || key.startsWith("file")) pushFile(val);
      }

      if (files.length === 0) {
        return c.json({ error: "กรุณาแนบไฟล์ต้นทางอย่างน้อย 1 ไฟล์ (.pdf / .docx / รูป)" }, 400);
      }
      if (files.length > MAX_SOURCE_FILES) {
        return c.json({ error: `แนบได้สูงสุด ${MAX_SOURCE_FILES} ไฟล์ต่อครั้ง` }, 400);
      }

      let total = 0;
      for (const f of files) {
        if (f.size <= 0) {
          return c.json({ error: `ไฟล์ ${f.name} ว่างเปล่า` }, 400);
        }
        if (f.size > MAX_SOURCE_FILE_BYTES) {
          return c.json({ error: `ไฟล์ ${f.name} ใหญ่เกิน 25 MB` }, 400);
        }
        total += f.size;
      }
      if (total > MAX_SOURCE_TOTAL_BYTES) {
        return c.json({ error: "ขนาดไฟล์รวมเกิน 40 MB" }, 400);
      }

      const payloads = await Promise.all(
        files.map(async (f) => ({
          buffer: Buffer.from(await f.arrayBuffer()),
          filename: f.name || "source",
          mimeType: f.type,
        })),
      );

      // JSON skeleton must come from the client (Export builder) at send-to-AI time —
      // never invented here on template upload.
      const valuesJsonRaw = form.get("valuesJson");
      if (typeof valuesJsonRaw !== "string" || !valuesJsonRaw.trim()) {
        return c.json(
          {
            error:
              "ต้องส่ง valuesJson ที่สร้างตอนจะส่งให้ AI (รูปแบบเดียวกับ Export JSON)",
          },
          400,
        );
      }
      let skeleton: DocxFormValuesJson;
      try {
        const parsed = JSON.parse(valuesJsonRaw) as DocxFormValuesJson;
        if (!parsed || parsed.format !== "docx-form-values") {
          return c.json(
            { error: "valuesJson ต้องเป็นรูปแบบ docx-form-values" },
            400,
          );
        }
        skeleton = parsed;
      } catch {
        return c.json({ error: "valuesJson ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }

      type ProgressEvt = {
        type: "log" | "progress" | "result" | "error";
        message?: string;
        step?: number;
        total?: number;
        label?: string;
        error?: string;
        code?: string;
        valuesJson?: DocxFormValuesJson;
        values?: unknown;
        skip?: unknown;
        rowSkip?: unknown;
        extracted?: unknown;
        ai?: unknown;
      };

      const runMap = async (emit: (evt: ProgressEvt) => void | Promise<void>) => {
        const [{ detectKind }, { fillDocxFormValues }, { sourceFilesMeta }] =
          await Promise.all([
            import("./source-extract"),
            import("./ai-fill"),
            import("./source-map"),
          ]);
        const providerLabel =
          getAiProvider(clientProvider)?.label || clientProvider;
        const totalSteps = payloads.length + 2; // prepare*N + AI once + done
        emit({
          type: "log",
          message: `เริ่มแมป ${payloads.length} ไฟล์ · ${providerLabel} · ${clientModel} · ส่งไฟล์ต้นทางให้ AI อ่าน`,
        });
        emit({
          type: "progress",
          step: 0,
          total: totalSteps,
          label: "เตรียมแนบไฟล์ต้นทาง",
        });

        for (let i = 0; i < payloads.length; i += 1) {
          const p = payloads[i];
          const kind = detectKind(p.filename, p.mimeType);
          const kindLabel =
            kind === "image"
              ? "รูป"
              : kind === "pdf"
                ? "PDF"
                : kind === "docx"
                  ? "Word"
                  : "ไฟล์";
          const kb = Math.max(1, Math.round(p.buffer.length / 1024));
          await emit({
            type: "log",
            message: `[${i + 1}/${payloads.length}] แนบ${kindLabel}: ${p.filename} (${kb} KB)`,
          });
          await emit({
            type: "progress",
            step: i + 1,
            total: totalSteps,
            label: `เตรียมแนบ ${i + 1}/${payloads.length}`,
          });
        }

        await emit({
          type: "log",
          message: `ส่งโครง Export JSON + ไฟล์ต้นทางให้ ${providerLabel} กรอกค่า แล้วรอ JSON กลับ (1 ครั้ง)…`,
        });
        await emit({
          type: "progress",
          step: payloads.length + 1,
          total: totalSteps,
          label: "รอ AI อ่านไฟล์แล้วกรอก JSON",
        });

        assertNotAborted(c.req.raw.signal);
        await emit({
          type: "log",
          message: `ส่งไฟล์ต้นทางจริง + Export JSON · ฟิลด์ ${fields.length} ตัว`,
        });
        const { inspectSourceTruncation } = await import("./ai-fill");
        const truncMeta = await inspectSourceTruncation(payloads);
        const valuesJson = await runWithSavedAiKeyAuthFallback(aiCreds, (effective) =>
          fillDocxFormValues(skeleton, payloads, {
            provider: effective.provider || clientProvider,
            apiKey: effective.apiKey || clientKey,
            model: effective.model || clientModel,
            fields,
            signal: c.req.raw.signal,
          }),
        );
        const { countFilledValues } = await import("./source-map");
        const fillStats = countFilledValues(valuesJson);
        await emit({
          type: "log",
          message: `ได้ Export JSON ที่ AI กรอกแล้ว — ${summarizeAiValuesJson(valuesJson)}`,
        });
        await emit({
          type: "progress",
          step: totalSteps,
          total: totalSteps,
          label: "พร้อม Import JSON ลงหน้าจอ",
        });

        const warnings: string[] = [];
        if (truncMeta.sourceTruncated) {
          warnings.push(
            "ต้นทางยาวเกินขีดจำกัดบริบท — ข้อมูลช่วงท้ายอาจไม่ครบ",
          );
        }
        if (fillStats.filled === 0) {
          warnings.push(
            "ไม่พบค่าที่ใช้ได้จากเอกสารต้นทาง — ค่าที่กรอกไว้จะไม่ถูกล้าง",
          );
        }

        await emit({
          type: "result",
          valuesJson,
          values: valuesJson.values,
          skip: valuesJson.skip,
          rowSkip: valuesJson.rowSkip,
          extracted: sourceFilesMeta(payloads),
          ai: {
            used: true,
            mode: "export-json-fill-files",
            fillStats,
            sourceTruncated: truncMeta.sourceTruncated,
            truncatedFiles: truncMeta.truncatedFiles,
            relevant: fillStats.filled > 0,
            warnings,
          },
          message:
            fillStats.filled === 0
              ? "ไม่พบค่าที่ใช้ได้จากต้นทาง"
              : "แมปเสร็จ",
        });
      };

      if (!wantStream) {
        let payload: {
          valuesJson: DocxFormValuesJson;
          values: unknown;
          skip: unknown;
          rowSkip: unknown;
          extracted: unknown;
          ai: unknown;
        } | null = null;
        await runMap((evt) => {
          if (evt.type === "result" && evt.valuesJson) {
            payload = {
              valuesJson: evt.valuesJson,
              values: evt.values,
              skip: evt.skip,
              rowSkip: evt.rowSkip,
              extracted: evt.extracted,
              ai: evt.ai,
            };
          }
          if (evt.type === "error") throw new Error(evt.error || "แมปไม่สำเร็จ");
        });
        if (!payload) {
          return c.json({ error: "แมปเอกสารต้นทางไม่สำเร็จ" }, 400);
        }
        return c.json(payload);
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = async (evt: ProgressEvt) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(evt)}\n`));
          };
          try {
            await runMap(emit);
          } catch (err) {
            const { aiProviderErrorJsonBody: mapErr } = await import(
              "./ai-request"
            );
            const body = mapErr(
              err,
              sharedServerKeyErrorOpts(aiCreds, clientProvider),
            );
            const message = body.error;
            const banner = message.startsWith("แมปเอกสารต้นทางไม่สำเร็จ")
              ? message
              : `แมปเอกสารต้นทางไม่สำเร็จ — ${message}`;
            await emit({
              type: "error",
              error: banner,
              message,
              code: body.code,
            });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      const { aiProviderErrorJsonBody: mapErr } = await import("./ai-request");
      const body = mapErr(
        err,
        sharedServerKeyErrorOpts(aiCreds, clientProvider),
      );
      const message = body.error;
      const banner = message.startsWith("แมปเอกสารต้นทางไม่สำเร็จ")
        ? message
        : `แมปเอกสารต้นทางไม่สำเร็จ — ${message}`;
      return c.json({ error: banner, code: body.code }, 400);
    }
  });

  api.post("/template/tag", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.TemplateTagger);
    if (denied) return denied;
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "กรุณาอัปโหลดไฟล์ .docx" }, 400);
      }
      if (!isDocx(file)) {
        return c.json(
          {
            error:
              file.name.toLowerCase().endsWith(".doc")
                ? "รองรับเฉพาะ .docx — ให้ Save As เป็น .docx ใน Word ก่อน"
                : "ไฟล์ต้องเป็น .docx เท่านั้น",
          },
          400,
        );
      }
      if (file.size > MAX_DOCX_BYTES) {
        return c.json({ error: "ไฟล์ใหญ่เกินไป (สูงสุด 25 MB)" }, 400);
      }

      const tagger = await import("./template-tagger");
      const replacementsRaw = form.get("replacements");
      let replacements: Parameters<typeof tagger.tagTemplate>[1] = [];
      if (typeof replacementsRaw === "string" && replacementsRaw.trim()) {
        try {
          const parsed = JSON.parse(replacementsRaw) as unknown;
          if (!Array.isArray(parsed)) {
            return c.json({ error: "replacements ต้องเป็นอาร์เรย์" }, 400);
          }
          replacements = parsed as Parameters<typeof tagger.tagTemplate>[1];
        } catch {
          return c.json({ error: "replacements ต้องเป็น JSON ที่ถูกต้อง" }, 400);
        }
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const { assertDocxReadable } = await import("./docx-errors");
      await assertDocxReadable(buffer);
      const result = await tagger.tagTemplate(buffer, replacements);
      const base = file.name.replace(/\.docx$/i, "") || "template";
      const outName = `${base}-tagged.docx`;

      return c.json({
        filename: outName,
        sourceFilename: file.name,
        plainText: result.plainText,
        content: result.content,
        layout: result.layout,
        replacementCount: replacements.length,
        docxBase64: result.buffer.toString("base64"),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      });
    } catch (err) {
      const message = formatTemplateError(err);
      return c.json(
        {
          error: message.startsWith("แท็กเทมเพลต")
            ? message
            : `แท็กเทมเพลตไม่สำเร็จ: ${message}`,
        },
        400,
      );
    }
  });

  /** AI draft {{tags}} for template tagger — BYOK; free via AiTagDraft. */
  api.post("/template/suggest-tags", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.AiTagDraft);
    if (denied) return denied;
    const {
      getOrCreateRequestId,
      logAiCall,
      aiProviderErrorJsonBody,
      isAiTimeoutError,
    } = await import("./ai-request");
    const requestId = getOrCreateRequestId(c.req.raw);
    const startedAt = Date.now();
    let logProvider = "";
    let logModel = "";
    let suggestCreds: ResolvedRequestAiCredentials | null = null;
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "กรุณาอัปโหลดไฟล์ .docx" }, 400);
      }
      if (!isDocx(file)) {
        return c.json(
          {
            error:
              file.name.toLowerCase().endsWith(".doc")
                ? "รองรับเฉพาะ .docx — ให้ Save As เป็น .docx ใน Word ก่อน"
                : "ไฟล์ต้องเป็น .docx เท่านั้น",
          },
          400,
        );
      }
      if (file.size > MAX_DOCX_BYTES) {
        return c.json({ error: "ไฟล์ใหญ่เกินไป (สูงสุด 25 MB)" }, 400);
      }

      const formKey =
        typeof form.get("geminiApiKey") === "string"
          ? String(form.get("geminiApiKey") || "").trim()
          : typeof form.get("aiApiKey") === "string"
            ? String(form.get("aiApiKey") || "").trim()
            : "";
      const formModel =
        typeof form.get("geminiModel") === "string"
          ? String(form.get("geminiModel") || "").trim()
          : typeof form.get("aiModel") === "string"
            ? String(form.get("aiModel") || "").trim()
            : "";
      const formProvider =
        typeof form.get("aiProvider") === "string"
          ? String(form.get("aiProvider") || "").trim()
          : "";
      const formNameLanguage =
        typeof form.get("nameLanguage") === "string"
          ? String(form.get("nameLanguage") || "").trim()
          : typeof form.get("tagNameLang") === "string"
            ? String(form.get("tagNameLang") || "").trim()
            : "";
      const sessionGate = await requireSessionUserId(c.req.raw);
      const sessionUserId = sessionGate.ok ? sessionGate.userId : null;
      const routed = await resolveRouteAiCredentials(c.req.raw, {
        formKey,
        formModel,
        formProvider,
      });
      if (!routed.ok) {
        return c.json(
          { error: routed.error },
          routed.status === 401 ? 400 : routed.status,
        );
      }
      const {
        creds: resolved,
        provider: clientProvider,
        apiKey: clientKey,
        model: clientModel,
      } = routed;
      suggestCreds = resolved;
      logProvider = clientProvider;
      logModel = clientModel;
      logAiCall({
        route: "/api/template/suggest-tags",
        provider: clientProvider,
        model: clientModel,
        requestId,
        outcome: "start",
        phase: "begin",
      });

      const buffer = Buffer.from(await file.arrayBuffer());
      const { assertDocxReadable } = await import("./docx-errors");
      await assertDocxReadable(buffer);
      const { parseAiTagNameLanguage, suggestTemplateTags } = await import(
        "./ai-tag-draft"
      );
      const nameLanguage = parseAiTagNameLanguage(formNameLanguage);

      let staffRaw = false;
      try {
        const { auth } = await import("./auth");
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
        staffRaw = roleIsStaffPaid(
          (session?.user as { role?: string } | undefined)?.role,
        );
      } catch {
        staffRaw = false;
      }

      const runSuggest = async (signal?: AbortSignal) => {
        const result = await runWithSavedAiKeyAuthFallback(resolved, (effective) =>
          suggestTemplateTags(buffer, {
            provider: effective.provider || clientProvider,
            apiKey: effective.apiKey || clientKey,
            model: effective.model || clientModel,
            filename: file.name,
            nameLanguage,
            signal,
          }),
        );
        const warnings: string[] = [];
        if (result.plainText.length > 0 && result.suggestions.length === 0) {
          warnings.push(
            "AI ไม่เสนอแท็กที่ผ่านการตรวจสอบ — ลองตรวจเอกสารหรือใส่แท็กเอง",
          );
        }
        return {
          suggestions: result.suggestions,
          count: result.suggestions.length,
          plainText: result.plainText,
          ...(warnings.length ? { warnings } : {}),
          ...(staffRaw
            ? { rawAi: result.rawAi, rawText: result.rawText }
            : {}),
          provider: clientProvider,
          model: clientModel,
          nameLanguage,
        };
      };

      const wantAsync =
        c.req.query("async") === "1" ||
        String(form.get("async") || "").trim() === "1";

      if (wantAsync) {
        const { startAiJob } = await import("./ai-jobs");
        const job = startAiJob({
          kind: "suggest-tags",
          ownerUserId: sessionUserId,
          run: async (emit, signal) => {
            emit({
              step: 1,
              total: 2,
              message: "กำลังส่งเอกสารให้ AI อ่าน…",
            });
            try {
              const payload = await runSuggest(signal);
              emit({ step: 2, total: 2, message: "เสร็จแล้ว" });
              logAiCall({
                route: "/api/template/suggest-tags",
                provider: clientProvider,
                model: clientModel,
                requestId,
                durationMs: Date.now() - startedAt,
                outcome: "ok",
                phase: "finish",
              });
              return payload;
            } catch (err) {
              const body = aiProviderErrorJsonBody(
                err,
                sharedServerKeyErrorOpts(resolved, clientProvider),
              );
              logAiCall({
                route: "/api/template/suggest-tags",
                provider: clientProvider,
                model: clientModel,
                requestId,
                durationMs: Date.now() - startedAt,
                errorClass: body.code,
                outcome: isAiTimeoutError(err) ? "timeout" : "error",
                phase: "finish",
              });
              const e = new Error(body.error) as Error & { code?: string };
              e.code = body.code;
              throw e;
            }
          },
        });
        return c.json(
          { ok: true, jobId: job.id, status: job.status, pollUrl: `/api/ai/jobs/${job.id}` },
          202,
        );
      }

      const payload = await runSuggest(c.req.raw.signal);
      logAiCall({
        route: "/api/template/suggest-tags",
        provider: clientProvider,
        model: clientModel,
        requestId,
        durationMs: Date.now() - startedAt,
        outcome: "ok",
        phase: "finish",
      });
      return c.json(payload);
    } catch (err) {
      const body = aiProviderErrorJsonBody(
        err,
        suggestCreds
          ? sharedServerKeyErrorOpts(suggestCreds, logProvider)
          : undefined,
      );
      logAiCall({
        route: "/api/template/suggest-tags",
        provider: logProvider || null,
        model: logModel || null,
        requestId,
        durationMs: Date.now() - startedAt,
        errorClass: body.code,
        outcome: isAiTimeoutError(err) ? "timeout" : "error",
        phase: "finish",
      });
      return c.json(
        {
          ...body,
          error:
            body.code === "AI_TIMEOUT"
              ? body.error
              : `AI ดราฟตัวแปรไม่สำเร็จ: ${body.error}`,
        },
        isAiTimeoutError(err) ? 504 : 400,
      );
    }
  });

  /**
   * One source pack → AI map to JSON per template schema (no document fill).
   * Form: files (sources×M), schemas = JSON [{ id, filename, fields }]
   */
  api.post("/batch-from-source", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.BatchFill);
    if (denied) return denied;

    const {
      getOrCreateRequestId,
      logAiCall,
      aiProviderErrorJsonBody,
      isAiTimeoutError,
    } = await import("./ai-request");
    const requestId = getOrCreateRequestId(c.req.raw);
    const startedAt = Date.now();
    let logProvider = "";
    let logModel = "";
    let batchCreds: ResolvedRequestAiCredentials | null = null;

    try {
      const form = await c.req.formData();
      const formKey =
        typeof form.get("geminiApiKey") === "string"
          ? String(form.get("geminiApiKey") || "").trim()
          : typeof form.get("aiApiKey") === "string"
            ? String(form.get("aiApiKey") || "").trim()
            : "";
      const formModel =
        typeof form.get("geminiModel") === "string"
          ? String(form.get("geminiModel") || "").trim()
          : typeof form.get("aiModel") === "string"
            ? String(form.get("aiModel") || "").trim()
            : "";
      const formProvider =
        typeof form.get("aiProvider") === "string"
          ? String(form.get("aiProvider") || "").trim()
          : "";
      const routed = await resolveRouteAiCredentials(c.req.raw, {
        formKey,
        formModel,
        formProvider,
      });
      if (!routed.ok) {
        return c.json({ error: routed.error }, routed.status);
      }
      const {
        creds: headerCreds,
        provider: clientProvider,
        apiKey: clientKey,
        model: clientModel,
      } = routed;
      batchCreds = headerCreds;
      logProvider = clientProvider;
      logModel = clientModel;
      logAiCall({
        route: "/api/batch-from-source",
        provider: clientProvider,
        model: clientModel,
        requestId,
        outcome: "start",
        phase: "begin",
      });

      const schemasRaw = form.get("schemas");
      if (typeof schemasRaw !== "string") {
        return c.json(
          {
            error:
              "ต้องส่ง schemas เป็น JSON ของแต่ละเทมเพลต [{ id, filename, fields }]",
          },
          400,
        );
      }

      type SchemaItem = {
        id?: string;
        filename?: string;
        fields?: FormField[];
        /** Prefer client Export-JSON skeleton when present */
        valuesJson?: DocxFormValuesJson;
      };
      let schemas: SchemaItem[];
      try {
        const parsed = JSON.parse(schemasRaw) as unknown;
        if (!Array.isArray(parsed) || !parsed.length) {
          return c.json({ error: "schemas ต้องเป็นอาร์เรย์ที่ไม่ว่าง" }, 400);
        }
        schemas = parsed as SchemaItem[];
      } catch {
        return c.json({ error: "schemas ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }
      {
        const ent = await resolveEntitlement(c.req.raw);
        const maxT = ent.maxMultiTemplates;
        if (schemas.length > maxT) {
          const paidCap =
            (await getAppLimits().catch(() => null))?.paidMaxMulti ?? 10;
          return c.json(
            {
              error: ent.paid
                ? `แมปได้ไม่เกิน ${maxT} เทมเพลตต่อครั้ง (จ่ายแล้ว)`
                : `บัญชีฟรีแมปได้ไม่เกิน ${maxT} เทมเพลตต่อครั้ง — จ่ายแล้วได้ถึง ${paidCap}`,
            },
            400,
          );
        }
      }

      const seenS = new Set<File>();
      const sources: File[] = [];
      const pushSource = (val: FormDataEntryValue | null) => {
        if (!(val instanceof File) || seenS.has(val)) return;
        seenS.add(val);
        sources.push(val);
      };
      for (const val of form.getAll("files")) pushSource(val);
      for (const [key, val] of form.entries()) {
        if (key === "files" || key === "schemas") continue;
        if (key === "geminiApiKey" || key === "geminiModel") continue;
        pushSource(val);
      }
      if (!sources.length) {
        return c.json({ error: "ต้องแนบเอกสารต้นทางอย่างน้อย 1 ไฟล์" }, 400);
      }

      let totalBytes = 0;
      for (const f of sources) {
        if (f.size > MAX_SOURCE_FILE_BYTES) {
          return c.json({ error: `ไฟล์ต้นทางใหญ่เกินไป: ${f.name}` }, 400);
        }
        totalBytes += f.size;
      }
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
        return c.json({ error: "รวมขนาดไฟล์ต้นทางใหญ่เกินไป" }, 400);
      }

      const payloads = await Promise.all(
        sources.map(async (f) => ({
          buffer: Buffer.from(await f.arrayBuffer()),
          filename: f.name || "source",
          mimeType: f.type,
        })),
      );

      const wantStream =
        c.req.query("stream") === "1" ||
        (c.req.header("accept") || "").includes("application/x-ndjson");
      const abortSignal = c.req.raw.signal;

      type BatchMapItem = {
        id: string | null;
        filename: string;
        ok: boolean;
        error?: string;
        fieldCount?: number;
        suggestions?: number;
        /** Same format as Export JSON / Import JSON */
        valuesJson?: DocxFormValuesJson;
      };
      type BatchEvt =
        | { type: "log"; message: string }
        | { type: "progress"; step: number; total: number; label: string }
        | {
            type: "batch-result";
            ok: boolean;
            mapped: number;
            total: number;
            results: BatchMapItem[];
            extracted: unknown;
            message?: string;
          }
        | { type: "error"; error: string; message?: string; code?: string };

      const runBatch = async (emit: (evt: BatchEvt) => void | Promise<void>) => {
        const [{ detectKind }, { fillDocxFormValuesBatch }, { sourceFilesMeta }] =
          await Promise.all([
            import("./source-extract"),
            import("./ai-fill"),
            import("./source-map"),
          ]);
        // prepare*N + 1 AI batch (N separate JSONs + source files once) + done
        const totalSteps = payloads.length + 2;
        const providerLabel =
          getAiProvider(clientProvider)?.label || clientProvider;
        await emit({
          type: "log",
          message: `เริ่มแมปหลายเทมเพลต · ต้นทาง ${payloads.length} ไฟล์ · เทมเพลต ${schemas.length} · ${providerLabel} · ${clientModel}`,
        });
        await emit({
          type: "log",
          message: `จะส่ง Export JSON แยกต่อเทมเพลต + ไฟล์ต้นทางให้ AI อ่าน`,
        });
        await emit({
          type: "progress",
          step: 0,
          total: totalSteps,
          label: "เตรียมแนบไฟล์ต้นทาง",
        });

        assertNotAborted(abortSignal);
        for (let i = 0; i < payloads.length; i += 1) {
          assertNotAborted(abortSignal);
          const p = payloads[i];
          const kind = detectKind(p.filename, p.mimeType);
          const kindLabel =
            kind === "image"
              ? "รูป"
              : kind === "pdf"
                ? "PDF"
                : kind === "docx"
                  ? "Word"
                  : "ไฟล์";
          const kb = Math.max(1, Math.round(p.buffer.length / 1024));
          await emit({
            type: "log",
            message: `[ต้นทาง ${i + 1}/${payloads.length}] แนบ${kindLabel}: ${p.filename} (${kb} KB)`,
          });
          await emit({
            type: "progress",
            step: i + 1,
            total: totalSteps,
            label: `เตรียมแนบ ${i + 1}/${payloads.length}`,
          });
        }

        const results: BatchMapItem[] = [];
        const fillItems: {
          id: string;
          filename: string;
          skeleton: DocxFormValuesJson;
          fields: FormField[];
        }[] = [];

        for (let i = 0; i < schemas.length; i += 1) {
          const schema = schemas[i];
          const name = String(
            schema.valuesJson?.template ||
              schema.filename ||
              `template-${i + 1}.docx`,
          );
          const id =
            schema.id != null && String(schema.id)
              ? String(schema.id)
              : `schema-${i}`;
          const templateFields = Array.isArray(schema.fields)
            ? (schema.fields as FormField[])
            : [];
          const skeleton =
            schema.valuesJson && schema.valuesJson.format === "docx-form-values"
              ? schema.valuesJson
              : null;
          if (!skeleton) {
            results.push({
              id,
              filename: name,
              ok: false,
              error:
                "ต้องส่ง valuesJson ที่สร้างตอนจะส่งให้ AI (รูปแบบ Export JSON) — ไม่สร้างตอนโหลดไฟล์",
            });
            await emit({
              type: "log",
              message: `  ✗ ${name}: ไม่มีโครง Export JSON จากไคลเอนต์`,
            });
            continue;
          }
          if (!templateFields.length) {
            results.push({
              id,
              filename: name,
              ok: false,
              error: "ไม่มี fields ของเทมเพลตสำหรับแมป",
            });
            await emit({
              type: "log",
              message: `  ✗ ${name}: schemas.fields ว่าง`,
            });
            continue;
          }
          fillItems.push({
            id,
            filename: name,
            skeleton,
            fields: templateFields,
          });
          await emit({
            type: "log",
            message: `เตรียม Export JSON แยก #${fillItems.length}: 「${name}」 · ฟิลด์ ${templateFields.length} ตัว`,
          });
        }

        if (fillItems.length) {
          assertNotAborted(abortSignal);
          const names = fillItems.map((t) => t.filename).join(", ");
          await emit({
            type: "log",
            message:
              fillItems.length === 1
                ? `ส่งโครง Export JSON + ไฟล์ต้นทางให้ AI กรอก (รอบเดียว)`
                : `ส่งชุด Export JSON ${fillItems.length} ไฟล์แยก + ไฟล์ต้นทางจริง ให้ AI รอบเดียว · ${names}`,
          });
          await emit({
            type: "progress",
            step: payloads.length,
            total: totalSteps,
            label:
              fillItems.length === 1
                ? `AI อ่านไฟล์แล้วกรอก — ${fillItems[0].filename}`
                : `AI อ่านไฟล์แล้วกรอก Export JSON ${fillItems.length} ชุด`,
          });

          try {
            const filled = await runWithSavedAiKeyAuthFallback(
              headerCreds,
              (effective) =>
                fillDocxFormValuesBatch(fillItems, payloads, {
                  provider: effective.provider || clientProvider,
                  apiKey: effective.apiKey || clientKey,
                  model: effective.model || clientModel,
                  signal: abortSignal,
                }),
            );
            for (const item of filled) {
              results.push({
                id: item.id,
                filename: item.filename,
                ok: true,
                fieldCount: item.valuesJson.fields?.length || 0,
                suggestions: Object.keys(item.valuesJson.values || {}).length,
                valuesJson: item.valuesJson,
              });
              await emit({
                type: "log",
                message: `  ✓ ${item.filename}: ${summarizeAiValuesJson(item.valuesJson)}`,
              });
            }
          } catch (err) {
            // Timeouts / auth failures must surface as route-level errors
            // (not silent per-template failures) so the UI can stop spinning.
            if (isAiTimeoutError(err)) throw err;
            const hay =
              err instanceof Error ? err.message : String(err || "");
            if (/API key|หมดอายุ|สิทธิ์ไม่ถูกต้อง|Authentication|unauthorized/i.test(hay)) {
              throw err;
            }
            const error = formatTemplateError(err);
            for (const item of fillItems) {
              if (results.some((r) => r.id === item.id && r.ok)) continue;
              results.push({
                id: item.id,
                filename: item.filename,
                ok: false,
                error,
              });
            }
            await emit({
              type: "log",
              message: `  ✗ ชุด Export JSON: ${error}`,
            });
          }
        }

        const okCount = results.filter((r) => r.ok).length;
        await emit({
          type: "progress",
          step: totalSteps,
          total: totalSteps,
          label: `เสร็จ ${okCount}/${results.length} เทมเพลต`,
        });
        if (!okCount) {
          const reasons = results
            .map((r) => `${r.filename}: ${r.error || "ไม่ทราบสาเหตุ"}`)
            .slice(0, 4)
            .join(" · ");
          await emit({
            type: "error",
            error: `แมป JSON ไม่สำเร็จทุกไฟล์ — ${reasons}`,
            message: reasons,
          });
          return;
        }
        await emit({
          type: "batch-result",
          ok: true,
          mapped: okCount,
          total: results.length,
          results,
          extracted: sourceFilesMeta(payloads),
          message: `แมปเสร็จ ${okCount}/${results.length} เทมเพลต — พร้อม Import ลงจอ`,
        });
      };

      if (!wantStream) {
        const box: {
          payload: Extract<BatchEvt, { type: "batch-result" }> | null;
          error: string | null;
          errorCode: string | null;
        } = { payload: null, error: null, errorCode: null };
        try {
          await runBatch((evt) => {
            if (evt.type === "batch-result") box.payload = evt;
            if (evt.type === "error") box.error = evt.error;
          });
        } catch (err) {
          const body = aiProviderErrorJsonBody(
            err,
            sharedServerKeyErrorOpts(headerCreds, clientProvider),
          );
          box.error = body.error;
          box.errorCode = body.code;
        }
        if (box.error || !box.payload) {
          logAiCall({
            route: "/api/batch-from-source",
            provider: clientProvider,
            model: clientModel,
            requestId,
            durationMs: Date.now() - startedAt,
            errorClass: box.errorCode || "AI_PROVIDER_ERROR",
            outcome: box.errorCode === "AI_TIMEOUT" ? "timeout" : "error",
            phase: "finish",
          });
          return c.json(
            {
              error: box.error || "แมปหลายเทมเพลตไม่สำเร็จ",
              code: box.errorCode || "AI_PROVIDER_ERROR",
            },
            box.errorCode === "AI_TIMEOUT" ? 504 : 400,
          );
        }
        logAiCall({
          route: "/api/batch-from-source",
          provider: clientProvider,
          model: clientModel,
          requestId,
          durationMs: Date.now() - startedAt,
          outcome: "ok",
          phase: "finish",
        });
        return c.json({
          ok: true,
          mapped: box.payload.mapped,
          total: box.payload.total,
          results: box.payload.results,
          extracted: box.payload.extracted,
        });
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = async (evt: BatchEvt) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(evt)}\n`));
          };
          try {
            await runBatch(emit);
            logAiCall({
              route: "/api/batch-from-source",
              provider: clientProvider,
              model: clientModel,
              requestId,
              durationMs: Date.now() - startedAt,
              outcome: "ok",
              phase: "finish",
            });
          } catch (err) {
            const body = aiProviderErrorJsonBody(
              err,
              sharedServerKeyErrorOpts(headerCreds, clientProvider),
            );
            const message = body.error;
            const cancelled =
              (err instanceof Error && err.name === "AbortError") ||
              /ยกเลิกโดยผู้ใช้/i.test(message);
            logAiCall({
              route: "/api/batch-from-source",
              provider: clientProvider,
              model: clientModel,
              requestId,
              durationMs: Date.now() - startedAt,
              errorClass: cancelled ? "ABORTED" : body.code,
              outcome: isAiTimeoutError(err) ? "timeout" : "error",
              phase: "finish",
            });
            await emit({
              type: "error",
              error: cancelled
                ? "ยกเลิกโดยผู้ใช้"
                : body.code === "AI_TIMEOUT"
                  ? body.error
                  : `แมปหลายเทมเพลตไม่สำเร็จ: ${message}`,
              message,
              code: cancelled ? undefined : body.code,
            });
          } finally {
            controller.close();
          }
        },
        cancel() {
          /* client aborted */
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      const body = aiProviderErrorJsonBody(
        err,
        batchCreds
          ? sharedServerKeyErrorOpts(batchCreds, logProvider)
          : undefined,
      );
      logAiCall({
        route: "/api/batch-from-source",
        provider: logProvider || null,
        model: logModel || null,
        requestId,
        durationMs: Date.now() - startedAt,
        errorClass: body.code,
        outcome: isAiTimeoutError(err) ? "timeout" : "error",
        phase: "finish",
      });
      return c.json(
        {
          error:
            body.code === "AI_TIMEOUT"
              ? body.error
              : `แมปหลายเทมเพลตไม่สำเร็จ: ${body.error}`,
          code: body.code,
        },
        isAiTimeoutError(err) ? 504 : 400,
      );
    }
  });

  /**
   * Fill many templates from client-side form values → ZIP.
   * No AI. Form: templates (docx×N), items = JSON [{ filename, values }]
   */
  api.post("/batch-fill", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.BatchFill);
    if (denied) return denied;

    try {
      const form = await c.req.formData();
      const templates: File[] = [];
      const seenT = new Set<File>();
      for (const val of form.getAll("templates")) {
        if (val instanceof File && !seenT.has(val)) {
          seenT.add(val);
          templates.push(val);
        }
      }
      if (!templates.length) {
        return c.json({ error: "ต้องส่งเทมเพลต .docx อย่างน้อย 1 ไฟล์" }, 400);
      }
      {
        const ent = await resolveEntitlement(c.req.raw);
        const maxT = ent.maxMultiTemplates;
        if (templates.length > maxT) {
          const paidCap =
            (await getAppLimits().catch(() => null))?.paidMaxMulti ?? 10;
          return c.json(
            {
              error: ent.paid
                ? `สร้างได้ไม่เกิน ${maxT} ไฟล์ต่อครั้ง (จ่ายแล้ว)`
                : `บัญชีฟรีสร้างได้ไม่เกิน ${maxT} ไฟล์ต่อครั้ง — จ่ายแล้วได้ถึง ${paidCap}`,
            },
            400,
          );
        }
      }

      const itemsRaw = form.get("items");
      if (typeof itemsRaw !== "string") {
        return c.json(
          { error: "ต้องส่ง items เป็น JSON [{ filename, values }]" },
          400,
        );
      }
      type FillItem = {
        filename?: string;
        values?: Record<string, unknown>;
        skip?: Record<string, boolean>;
        rowSkip?: Record<string, Record<string, boolean>[]>;
      };
      let items: FillItem[];
      try {
        const parsed = JSON.parse(itemsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== templates.length) {
          return c.json(
            { error: "จำนวน items ต้องเท่ากับจำนวนเทมเพลต" },
            400,
          );
        }
        items = parsed as FillItem[];
      } catch {
        return c.json({ error: "items ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }

      type BatchFillResult = {
        filename: string;
        ok: boolean;
        error?: string;
        filledName?: string;
      };
      const results: BatchFillResult[] = [];
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();

      for (let i = 0; i < templates.length; i += 1) {
        const tmpl = templates[i];
        const name = tmpl.name || items[i]?.filename || `template-${i + 1}.docx`;
        try {
          if (!isDocx(tmpl) || tmpl.size > MAX_DOCX_BYTES) {
            results.push({
              filename: name,
              ok: false,
              error: "เทมเพลตไม่ถูกต้องหรือใหญ่เกินไป",
            });
            continue;
          }
          const values = items[i]?.values;
          if (!values || typeof values !== "object") {
            results.push({
              filename: name,
              ok: false,
              error: "ไม่มี values สำหรับเทมเพลตนี้",
            });
            continue;
          }
          const buffer = Buffer.from(await tmpl.arrayBuffer());
          const skip = items[i]?.skip;
          const rowSkip = items[i]?.rowSkip;
          let fillValues = values;
          if (
            (skip && typeof skip === "object") ||
            (rowSkip && typeof rowSkip === "object")
          ) {
            const { toFillValues } = await import("./source-map");
            const parsed = await parseTemplate(buffer);
            fillValues = toFillValues(
              parsed.fields,
              values,
              skip && typeof skip === "object" ? skip : {},
              rowSkip && typeof rowSkip === "object" ? rowSkip : {},
            );
          } else {
            // Empty loop tables are allowed — missing list keys become [].
            const parsed = await parseTemplate(buffer);
            for (const f of parsed.fields) {
              if (f.type === "list" && fillValues[f.name] == null) {
                fillValues[f.name] = [];
              }
            }
          }
          const out = await fillTemplate({
            template: buffer,
            values: fillValues,
            images: [],
          });
          const filledName = `${name.replace(/\.docx$/i, "") || "document"}-filled.docx`;
          zip.file(filledName, out);
          results.push({ filename: name, ok: true, filledName });
        } catch (err) {
          results.push({
            filename: name,
            ok: false,
            error: formatTemplateError(err),
          });
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      if (!okCount) {
        const reasons = results
          .map((r) => `${r.filename}: ${r.error || "ไม่ทราบสาเหตุ"}`)
          .slice(0, 4)
          .join(" · ");
        return c.json(
          {
            error: `สร้างเอกสารไม่สำเร็จทุกไฟล์ — ${reasons}`,
            results,
          },
          400,
        );
      }

      const zipBuf = Buffer.from(
        await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        }),
      );
      return c.json({
        ok: true,
        results,
        zipBase64: zipBuf.toString("base64"),
        zipName: `docx-form-batch-${okCount}files.zip`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `สร้างหลายเอกสารไม่สำเร็จ: ${message}` }, 400);
    }
  });

  api.post("/fill", async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json(
          { error: "กรุณาส่งไฟล์เทมเพลต .docx", code: "FILL_MISSING_FILE" },
          400,
        );
      }
      if (!isDocx(file) || file.size > MAX_DOCX_BYTES) {
        return c.json(
          {
            error: "ไฟล์เทมเพลตไม่ถูกต้องหรือใหญ่เกินไป",
            code: "FILL_INVALID_FILE",
          },
          400,
        );
      }

      const valuesRaw = form.get("values");
      if (typeof valuesRaw !== "string") {
        return c.json(
          {
            error: "ต้องส่งค่า values เป็น JSON",
            code: "FILL_MISSING_VALUES",
          },
          400,
        );
      }

      let values: Record<string, unknown>;
      try {
        values = JSON.parse(valuesRaw) as Record<string, unknown>;
      } catch {
        return c.json(
          { error: "values ต้องเป็น JSON ที่ถูกต้อง", code: "FILL_BAD_JSON" },
          400,
        );
      }

      /**
       * Optional skip maps (docx-form-values style). When present, the server
       * applies toFillValues so skipped scalars become "" and skipped / empty
       * loop tables become [] — leftover {{tags}} are removed by the engine.
       * Existing clients that already send pre-transformed values may omit these.
       */
      let skip: Record<string, boolean> = {};
      let rowSkip: Record<string, Record<string, boolean>[]> = {};
      const skipRaw = form.get("skip");
      if (typeof skipRaw === "string" && skipRaw.trim()) {
        try {
          const parsed = JSON.parse(skipRaw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            skip = parsed as Record<string, boolean>;
          }
        } catch {
          return c.json(
            { error: "skip ต้องเป็น JSON object", code: "FILL_BAD_SKIP" },
            400,
          );
        }
      }
      const rowSkipRaw = form.get("rowSkip");
      if (typeof rowSkipRaw === "string" && rowSkipRaw.trim()) {
        try {
          const parsed = JSON.parse(rowSkipRaw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            rowSkip = parsed as Record<string, Record<string, boolean>[]>;
          }
        } catch {
          return c.json(
            {
              error: "rowSkip ต้องเป็น JSON object",
              code: "FILL_BAD_ROW_SKIP",
            },
            400,
          );
        }
      }

      const images: {
        name: string;
        buffer: Buffer;
        filename: string;
        mimeType?: string;
      }[] = [];

      for (const [key, val] of form.entries()) {
        if (!key.startsWith("image:") || !(val instanceof File)) continue;
        const name = key.slice("image:".length);
        if (!name) continue;
        if (val.size === 0) continue;
        if (skip[name]) continue;
        if (val.size > MAX_IMAGE_BYTES) {
          return c.json(
            { error: `รูป ${name} ใหญ่เกิน 8 MB`, code: "FILL_IMAGE_TOO_LARGE" },
            400,
          );
        }
        const type = (val.type || "").toLowerCase();
        if (
          type &&
          !type.startsWith("image/") &&
          type !== "application/octet-stream"
        ) {
          return c.json(
            {
              error: `ไฟล์สำหรับ ${name} ไม่ใช่รูปภาพ`,
              code: "FILL_IMAGE_INVALID",
            },
            400,
          );
        }
        images.push({
          name,
          buffer: Buffer.from(await val.arrayBuffer()),
          filename: val.name || `${name}.png`,
          mimeType: val.type,
        });
      }

      const template = Buffer.from(await file.arrayBuffer());
      const parsed = await parseTemplate(template);
      const hasSkipMaps =
        Object.keys(skip).length > 0 || Object.keys(rowSkip).length > 0;
      // Always run through toFillValues when skip maps are present so empty
      // loop tables ([]) and skipped fields render cleanly with no leftover tags.
      // When skip maps are absent, keep legacy behaviour (client pre-transformed
      // values) but still normalise empty arrays for list fields found in the
      // template so generating with [] is never rejected.
      const { toFillValues } = await import("./source-map");
      let fillValues = values;
      if (hasSkipMaps) {
        fillValues = toFillValues(parsed.fields, values, skip, rowSkip);
      } else {
        // Honour empty loop tables already in values (Frontend may send []).
        for (const f of parsed.fields) {
          if (f.type !== "list") continue;
          const v = values[f.name];
          if (v == null) {
            // Missing list key → treat as empty loop (no leftover tags).
            values[f.name] = [];
          } else if (!Array.isArray(v)) {
            return c.json(
              {
                error: `ฟิลด์ลิสต์「${f.name}」ต้องเป็นอาร์เรย์ (ว่างได้เมื่อข้าม)`,
                code: "FILL_LIST_NOT_ARRAY",
              },
              400,
            );
          }
        }
        fillValues = values;
      }

      const out = await fillTemplate({
        template,
        values: fillValues,
        images,
      });

      const base = file.name.replace(/\.docx$/i, "") || "document";
      const utf8Name = `${base}-filled.docx`;
      // HTTP headers must be ASCII; keep a safe fallback + RFC 5987 for Thai names
      const asciiName =
        utf8Name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") ||
        "document-filled.docx";
      const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;

      return new Response(new Uint8Array(out), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": disposition,
        },
      });
    } catch (err) {
      const message = formatTemplateError(err);
      return c.json({ error: `สร้างเอกสารไม่สำเร็จ: ${message}` }, 400);
    }
  });

  return api;
}
