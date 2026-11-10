import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultModelForProvider,
  getAiProvider,
  listAiProvidersPublic,
  normalizeProviderModel,
  resolveEffectiveModelForProvider,
  type AiProviderId,
} from "./ai-providers";
import { getAiTimeoutMs } from "./ai-request";

const CURSOR_SERVER_KEY_ENV = "DOCX_FORM_CURSOR_API_KEY";

export type AiConfig = {
  /** Google AI Studio / Gemini API key — only used when BYOK is off (legacy/local) */
  geminiApiKey?: string;
  geminiModel?: string;
};

export type RequestAiCredentials = {
  provider: AiProviderId | string;
  apiKey?: string;
  model?: string;
};

/** Credentials after vault / header resolution (may include vault metadata). */
export type ResolvedRequestAiCredentials = RequestAiCredentials & {
  keyId?: string;
  /** True when apiKey came from this user's vault row. */
  fromUserVault?: boolean;
  /** Vault label for error messages (never a secret). */
  keyLabel?: string;
  /** X-Ai-Key-Id that was requested, even when the row was missing/deleted. */
  requestedKeyId?: string;
  /** True when missing vault key was replaced by DOCX_FORM_CURSOR_API_KEY. */
  usedSharedEnvFallback?: boolean;
};

function resolveConfigDir(): string {
  const fromEnv = String(process.env.DOCX_FORM_CONFIG_DIR || "").trim();
  if (fromEnv) return fromEnv;

  const home = homedir();
  if (
    home &&
    home !== "/nonexistent" &&
    !home.startsWith("/nonexistent") &&
    existsSync(home)
  ) {
    try {
      accessSync(home, constants.W_OK);
      return join(home, ".docx-form");
    } catch {
      /* fall through */
    }
  }
  return join(tmpdir(), "docx-form");
}

const CONFIG_DIR = resolveConfigDir();
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const GEMINI_MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (แนะนำ)" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)" },
  { id: "gemini-flash-latest", label: "gemini-flash-latest" },
];

/** Web default: users bring their own key — never persist on server. */
export function isByokOnly(): boolean {
  const v = String(process.env.DOCX_FORM_BYOK_ONLY ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function readAiConfig(): AiConfig {
  if (isByokOnly()) return {};
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as AiConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function writeAiConfig(patch: Partial<AiConfig>): AiConfig {
  if (isByokOnly()) {
    // Do not write user keys to disk in web BYOK mode.
    return { ...readAiConfig(), ...patch, geminiApiKey: undefined };
  }
  const next: AiConfig = { ...readAiConfig(), ...patch };
  // turbopackIgnore: CONFIG_DIR is dynamic (env/home/tmp); without it Turbopack
  // traces the whole project into the server bundle.
  if (!existsSync(/* turbopackIgnore: true */ CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function clearGeminiKey(): AiConfig {
  if (isByokOnly()) return {};
  const cur = readAiConfig();
  delete cur.geminiApiKey;
  if (!existsSync(/* turbopackIgnore: true */ CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), "utf-8");
  return cur;
}

/** True when a Gemini key is persisted in the server config file (not env). */
export function hasServerFileGeminiKey(): boolean {
  if (isByokOnly()) return false;
  const cfg = readAiConfig().geminiApiKey;
  return Boolean(cfg && String(cfg).trim());
}

/** Mask for file-stored Gemini key only — never masks env key material. */
export function maskServerFileGeminiKey(): string | null {
  if (!hasServerFileGeminiKey()) return null;
  return maskGeminiKey(String(readAiConfig().geminiApiKey || ""));
}

/** Mask secrets for UI lists — last 4 only (never prefix+suffix of the secret). */
export function maskGeminiKey(key: string): string {
  const k = String(key || "").trim();
  if (!k) return "••••";
  if (k.length <= 4) return "••••";
  return `••••…${k.slice(-4)}`;
}

/** Key sent by the browser for this request only. */
export function getRequestGeminiKey(req?: Request | null): string | undefined {
  if (!req) return undefined;
  const raw =
    req.headers.get("x-ai-api-key") ||
    req.headers.get("x-gemini-api-key") ||
    req.headers.get("x-goog-api-key") ||
    "";
  const key = String(raw || "").trim();
  return key || undefined;
}

export function getRequestGeminiModel(req?: Request | null): string | undefined {
  if (!req) return undefined;
  return (
    normalizeProviderModel(
      getRequestAiProvider(req),
      req.headers.get("x-ai-model") || req.headers.get("x-gemini-model"),
    ) || undefined
  );
}

export function getRequestAiProvider(req?: Request | null): string {
  if (!req) return "google";
  const raw = String(
    req.headers.get("x-ai-provider") ||
      req.headers.get("x-docx-ai-provider") ||
      "",
  )
    .trim()
    .toLowerCase();
  if (!raw) return "google";
  const p = getAiProvider(raw);
  return p?.id || "google";
}

/** True when the client sent X-Ai-Provider (not the implicit google default). */
export function requestHasExplicitAiProvider(req?: Request | null): boolean {
  if (!req) return false;
  return Boolean(
    String(
      req.headers.get("x-ai-provider") ||
        req.headers.get("x-docx-ai-provider") ||
        "",
    ).trim(),
  );
}

export function adminDefaultProviderFromSettings(settings?: {
  defaultProvider?: string | null;
  defaultModel?: string | null;
}): string {
  const explicit = String(settings?.defaultProvider || "").trim();
  if (explicit) {
    const p = getAiProvider(explicit);
    if (p) return p.id;
  }
  return "google";
}

function providerHasUsableKey(
  providerId: string,
  requestKey?: string | null,
): boolean {
  return Boolean(resolveProviderApiKey(providerId, requestKey));
}

/**
 * Provider for users without a working key on their chosen default:
 * admin default when usable → else Cursor shared key → else requested.
 */
export function resolveEffectiveAiProvider(opts: {
  requestProvider?: string | null;
  explicitProvider?: boolean;
  requestKey?: string | null;
  adminDefaultProvider?: string | null;
}): string {
  const adminDefault =
    getAiProvider(opts.adminDefaultProvider)?.id || "google";
  const requested =
    getAiProvider(opts.requestProvider)?.id || "google";
  const explicit = !!opts.explicitProvider;
  const usable = (id: string) => providerHasUsableKey(id, opts.requestKey);

  if (explicit && usable(requested)) return requested;
  if (usable(adminDefault)) return adminDefault;
  if (adminDefault !== "cursor" && usable("cursor")) return "cursor";
  if (explicit) return requested;
  if (usable(requested)) return requested;
  return adminDefault;
}

/** Optional vault key id — server looks up the secret instead of accepting plaintext. */
export function getRequestAiKeyId(req?: Request | null): string | undefined {
  if (!req) return undefined;
  const id = String(
    req.headers.get("x-ai-key-id") ||
      req.headers.get("x-docx-ai-key-id") ||
      "",
  ).trim();
  return id || undefined;
}

/** Unified BYOK credentials from headers (new + legacy Gemini). */
export function getRequestAiCredentials(
  req?: Request | null,
): RequestAiCredentials {
  const provider = getRequestAiProvider(req);
  const apiKey = getRequestGeminiKey(req);
  const model =
    getRequestGeminiModel(req) || defaultModelForProvider(provider);
  return { provider, apiKey, model };
}

/**
 * Resolve credentials preferring vault key id (no plaintext round-trip).
 * Falls back to per-request API key header for unsynced / guest BYOK.
 * Missing/deleted vault ids do not throw — callers use
 * {@link coalesceAiCredentialsWithSharedEnv} / {@link missingAiCredentialsError}.
 */
export async function resolveRequestAiCredentials(
  req: Request,
  userId?: string | null,
): Promise<ResolvedRequestAiCredentials> {
  const base = getRequestAiCredentials(req);
  const keyId = getRequestAiKeyId(req);
  if (keyId && userId) {
    try {
      const { getUserAiKey } = await import("./ai-key-vault");
      const row = await getUserAiKey(userId, keyId);
      if (row?.apiKey) {
        return {
          provider: row.provider || base.provider,
          apiKey: row.apiKey,
          model:
            normalizeProviderModel(row.provider || base.provider, row.model) ||
            base.model ||
            defaultModelForProvider(row.provider || base.provider),
          keyId: row.id,
          requestedKeyId: keyId,
          fromUserVault: true,
          keyLabel: row.label || row.provider || row.id,
        };
      }
    } catch {
      /* fall through to header key */
    }
    return {
      ...base,
      keyId,
      requestedKeyId: keyId,
      fromUserVault: false,
    };
  }
  return { ...base, keyId, requestedKeyId: keyId, fromUserVault: false };
}

/**
 * Shared Cursor env key for auth/missing-vault fallback.
 * Reads DOCX_FORM_CURSOR_API_KEY even when BYOK-only is on (unlike getCursorApiKey).
 * Never log or return this value to clients.
 */
export function peekSharedCursorEnvApiKey(): string | undefined {
  const fromEnv = process.env[CURSOR_SERVER_KEY_ENV];
  const key = fromEnv && String(fromEnv).trim() ? String(fromEnv).trim() : "";
  return key || undefined;
}

export function formatSavedAiKeyAuthError(opts: {
  keyId?: string | null;
  label?: string | null;
}): string {
  const label = String(opts.label || "").trim();
  const id = String(opts.keyId || "").trim();
  if (label && id && label !== id) {
    return `คีย์ AI ที่บันทึกไว้「${label}」(id: ${id}) ถูกปฏิเสธจากผู้ให้บริการ (ไม่ถูกต้อง/หมดอายุ/ไม่มีสิทธิ์) — ตรวจคีย์นี้หรือตั้ง DOCX_FORM_CURSOR_API_KEY เป็นตัวสำรอง`;
  }
  if (label) {
    return `คีย์ AI ที่บันทึกไว้「${label}」ถูกปฏิเสธจากผู้ให้บริการ (ไม่ถูกต้อง/หมดอายุ/ไม่มีสิทธิ์) — ตรวจคีย์นี้หรือตั้ง DOCX_FORM_CURSOR_API_KEY เป็นตัวสำรอง`;
  }
  if (id) {
    return `คีย์ AI ที่บันทึกไว้ (id: ${id}) ถูกปฏิเสธจากผู้ให้บริการ (ไม่ถูกต้อง/หมดอายุ/ไม่มีสิทธิ์) — ตรวจคีย์นี้หรือตั้ง DOCX_FORM_CURSOR_API_KEY เป็นตัวสำรอง`;
  }
  return "คีย์ AI ที่บันทึกไว้ถูกปฏิเสธจากผู้ให้บริการ (ไม่ถูกต้อง/หมดอายุ/ไม่มีสิทธิ์)";
}

export function formatMissingVaultAiKeyError(opts: {
  keyId?: string | null;
}): string {
  const id = String(opts.keyId || "").trim();
  if (id) {
    return `ไม่พบคีย์ AI ที่บันทึกไว้ (id: ${id}) — อาจถูกลบแล้ว หรือไม่มีสิทธิ์ใช้คีย์นี้`;
  }
  return "ไม่พบคีย์ AI ที่บันทึกไว้ — อาจถูกลบแล้ว หรือไม่มีสิทธิ์ใช้คีย์นี้";
}

export function missingAiCredentialsError(
  creds?: Pick<ResolvedRequestAiCredentials, "requestedKeyId" | "fromUserVault"> | null,
): string {
  const requested = String(creds?.requestedKeyId || "").trim();
  if (requested && !creds?.fromUserVault) {
    return formatMissingVaultAiKeyError({ keyId: requested });
  }
  return "ยังไม่มี AI API key — กด «ใส่ AI key» แล้วเลือกผู้ให้บริการและใส่ key ของคุณ หรือซิงก์คีย์ขึ้นเซิร์ฟเวอร์แล้วส่ง X-Ai-Key-Id";
}

/**
 * When X-Ai-Key-Id was sent but the vault row is gone, use shared env Cursor key
 * if configured (same rule as auth rejection fallback). Otherwise leave unresolved.
 */
export function coalesceAiCredentialsWithSharedEnv(
  creds: ResolvedRequestAiCredentials,
): ResolvedRequestAiCredentials {
  if (creds.apiKey && String(creds.apiKey).trim()) return creds;
  const requested = String(creds.requestedKeyId || creds.keyId || "").trim();
  if (!requested) return creds;
  const shared = peekSharedCursorEnvApiKey();
  if (!shared) return creds;
  return {
    provider: "cursor",
    apiKey: shared,
    model: defaultModelForProvider("cursor"),
    keyId: requested,
    requestedKeyId: requested,
    fromUserVault: false,
    usedSharedEnvFallback: true,
  };
}

/**
 * Run an AI call; if the user's own vault key is rejected (auth only),
 * retry once with DOCX_FORM_CURSOR_API_KEY when configured.
 */
export async function runWithSavedAiKeyAuthFallback<T>(
  creds: ResolvedRequestAiCredentials,
  run: (effective: RequestAiCredentials) => Promise<T>,
): Promise<T> {
  try {
    return await run({
      provider: creds.provider,
      apiKey: creds.apiKey,
      model: creds.model,
    });
  } catch (err) {
    if (!creds.fromUserVault) throw err;
    const { isAiCredentialAuthError } = await import("./ai-http-errors");
    if (!isAiCredentialAuthError(err)) throw err;
    const shared = peekSharedCursorEnvApiKey();
    if (!shared) {
      throw new Error(
        formatSavedAiKeyAuthError({
          keyId: creds.keyId || creds.requestedKeyId,
          label: creds.keyLabel,
        }),
      );
    }
    return await run({
      provider: "cursor",
      apiKey: shared,
      model: defaultModelForProvider("cursor"),
    });
  }
}

/**
 * Resolve API key: per-request override → (if not BYOK) env/file.
 */
export function getGeminiApiKey(override?: string | null): string | undefined {
  if (override && String(override).trim()) return String(override).trim();
  if (isByokOnly()) return undefined;

  const fromEnv =
    process.env.DOCX_FORM_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const cfg = readAiConfig().geminiApiKey;
  return cfg && String(cfg).trim() ? String(cfg).trim() : undefined;
}

/** Shared Cursor key (DOCX_FORM_CURSOR_API_KEY) when BYOK-only is off; BYOK override wins. */
export function getCursorApiKey(override?: string | null): string | undefined {
  if (override && String(override).trim()) return String(override).trim();
  if (isByokOnly()) return undefined;
  const fromEnv = process.env[CURSOR_SERVER_KEY_ENV];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return undefined;
}

export function hasServerEnvCursorKey(): boolean {
  return Boolean(String(process.env[CURSOR_SERVER_KEY_ENV] || "").trim());
}

/** Effective API key: per-request BYOK → (when not BYOK-only) server env for Gemini/Cursor. */
export function resolveProviderApiKey(
  provider: string | null | undefined,
  override?: string | null,
): string | undefined {
  const p = getAiProvider(provider) || getAiProvider("google");
  if (p?.apiFamily === "gemini") return getGeminiApiKey(override);
  if (p?.apiFamily === "cursor") return getCursorApiKey(override);
  const key = String(override || "").trim();
  return key || undefined;
}

export function normalizeGeminiModel(raw: unknown): string | null {
  const id = String(raw || "")
    .trim()
    .replace(/^models\//i, "");
  if (!id) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return null;
  if (id.length > 80) return null;
  return id;
}

export function getGeminiModel(override?: string | null): string {
  return (
    normalizeGeminiModel(override) ||
    normalizeGeminiModel(readAiConfig().geminiModel) ||
    DEFAULT_GEMINI_MODEL
  );
}

/** Async resolve: request → file config → admin app_settings → default */
export async function getGeminiModelAsync(
  override?: string | null,
): Promise<string> {
  const fromOverride = normalizeGeminiModel(override);
  if (fromOverride) return fromOverride;
  const fromFile = normalizeGeminiModel(readAiConfig().geminiModel);
  if (fromFile) return fromFile;
  try {
    const { getAiAdminSettings } = await import("./admin-store");
    const admin = await getAiAdminSettings();
    return normalizeGeminiModel(admin.defaultModel) || DEFAULT_GEMINI_MODEL;
  } catch {
    return DEFAULT_GEMINI_MODEL;
  }
}

export type AiKeySource = "user" | "shared" | "none";

export function geminiStatus(opts?: {
  requestKey?: string | null;
  requestModel?: string | null;
  requestProvider?: string | null;
  explicitProvider?: boolean;
  /** Admin-configured default when file/env has none */
  adminDefaultModel?: string | null;
  adminDefaultProvider?: string | null;
  /** Vault / header resolution hints for truthful pill status. */
  fromUserVault?: boolean;
  keyId?: string | null;
  usedSharedEnvFallback?: boolean;
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestCode?: string | null;
  lastTestMessage?: string | null;
}) {
  const adminDefaultProvider = adminDefaultProviderFromSettings({
    defaultProvider: opts?.adminDefaultProvider,
    defaultModel: opts?.adminDefaultModel,
  });
  const providerId = resolveEffectiveAiProvider({
    requestProvider: opts?.requestProvider,
    explicitProvider: opts?.explicitProvider,
    requestKey: opts?.requestKey,
    adminDefaultProvider,
  });
  const provider = getAiProvider(providerId)!;
  const requestKey = opts?.requestKey && String(opts.requestKey).trim()
    ? String(opts.requestKey).trim()
    : undefined;
  const key =
    provider.apiFamily === "gemini"
      ? getGeminiApiKey(requestKey)
      : provider.apiFamily === "cursor"
        ? getCursorApiKey(requestKey)
        : requestKey;
  const rawModel =
    opts?.requestModel ||
    (provider.apiFamily === "gemini"
      ? normalizeGeminiModel(readAiConfig().geminiModel)
      : null) ||
    (provider.apiFamily === "gemini"
      ? normalizeGeminiModel(opts?.adminDefaultModel)
      : null) ||
    null;
  // Same resolver the fill/tag paths use — pill must not show a cross-family
  // leftover like gemini-3.8-flash when effective provider is Cursor.
  const model = resolveEffectiveModelForProvider(providerId, rawModel);
  const hasEnvGemini = !!(
    process.env.DOCX_FORM_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  );
  const hasEnvCursor = hasServerEnvCursorKey();
  const hasFileGemini = hasServerFileGeminiKey();
  const fromVault = Boolean(opts?.fromUserVault && key);
  const usedShared = Boolean(opts?.usedSharedEnvFallback);
  let keySource: AiKeySource = "none";
  if (fromVault || (requestKey && !usedShared)) {
    keySource = "user";
  } else if (key && (usedShared || hasEnvCursor || hasEnvGemini || hasFileGemini)) {
    keySource = "shared";
  } else if (key) {
    // Server resolved a key without vault/header — treat as shared.
    keySource = "shared";
  }
  const keyId =
    keySource === "user" && opts?.keyId ? String(opts.keyId).trim() || null : null;
  const lastTestOk =
    typeof opts?.lastTestOk === "boolean" ? opts.lastTestOk : null;
  const lastTestStatus: "ok" | "error" | "untested" | null =
    keySource === "user"
      ? lastTestOk === true
        ? "ok"
        : lastTestOk === false
          ? "error"
          : "untested"
      : null;
  const premiumEnforce =
    String(process.env.PREMIUM_ENFORCE || "").trim() === "1" ||
    String(process.env.PREMIUM_ENFORCE || "")
      .trim()
      .toLowerCase() === "true";
  return {
    connected: !!key,
    byok: isByokOnly(),
    provider: providerId,
    effectiveProvider: providerId,
    effectiveProviderLabel: provider.label,
    /** Same value as `model` — alias for pill/admin agreement. */
    effectiveModel: model,
    adminDefaultProvider,
    providerLabel: provider.label,
    apiFamily: provider.apiFamily,
    model,
    /** Server AI call budget (DOCX_FORM_AI_TIMEOUT_MS); client should wait slightly longer. */
    aiTimeoutMs: getAiTimeoutMs(),
    models: provider.models,
    /** Provider registry default for the effective provider (not admin setting). */
    defaultModel: provider.defaultModel,
    adminDefaultModel: normalizeGeminiModel(opts?.adminDefaultModel) || null,
    maskedKey: key && keySource === "user" ? maskGeminiKey(key) : keySource === "shared" ? null : null,
    keySource,
    keyId,
    lastTestAt: keySource === "user" ? opts?.lastTestAt || null : null,
    lastTestOk: keySource === "user" ? lastTestOk : null,
    lastTestCode: keySource === "user" ? opts?.lastTestCode || null : null,
    lastTestMessage: keySource === "user" ? opts?.lastTestMessage || null : null,
    lastTestStatus,
    hasServerEnvKey: hasEnvGemini,
    hasServerEnvCursorKey: hasEnvCursor,
    /** Human label only — never leak env var names. */
    serverEnvGeminiKeySource: hasEnvGemini ? "set via server" : null,
    serverEnvCursorKeySource: hasEnvCursor ? "set via server" : null,
    premiumEnforce,
    /** Human storage label — never leak filesystem paths. */
    configStore: isByokOnly() ? "browser" : "server-file",
    configStoreLabel: isByokOnly()
      ? "เบราว์เซอร์ (ไม่เก็บบนเซิร์ฟเวอร์)"
      : "เก็บบนเซิร์ฟเวอร์",
    studioUrl: provider.docsUrl,
    docsUrl: provider.docsUrl,
    providers: listAiProvidersPublic(),
  };
}

/** True when request carries a usable BYOK key for the given provider. */
export function hasRequestAiKey(
  provider: string | null | undefined,
  apiKey?: string | null,
): boolean {
  const p = getAiProvider(provider) || getAiProvider("google");
  if (p?.apiFamily === "gemini" || p?.apiFamily === "cursor") {
    return Boolean(resolveProviderApiKey(provider, apiKey));
  }
  const key = String(apiKey || "").trim();
  return key.length >= 8;
}
