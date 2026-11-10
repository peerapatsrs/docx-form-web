import { accessSync, constants, existsSync, readFileSync } from "node:fs";
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

/**
 * Legacy on-disk path (may be under /tmp on some hosts). Kept only as a
 * one-time read fallback when migrating into Postgres `app_settings`.
 * New writes go to the DB — never depend on /tmp for admin AI config.
 */
function resolveLegacyConfigDir(): string {
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

const LEGACY_CONFIG_DIR = resolveLegacyConfigDir();
const LEGACY_CONFIG_PATH = join(LEGACY_CONFIG_DIR, "config.json");
const AI_SERVER_SETTINGS_KEY = "ai_server";

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

/** @deprecated Human-facing APIs must not expose filesystem paths. */
export function getConfigPath(): string {
  return "(database)";
}

function readLegacyFileConfig(): AiConfig {
  try {
    if (!existsSync(LEGACY_CONFIG_PATH)) return {};
    const raw = JSON.parse(readFileSync(LEGACY_CONFIG_PATH, "utf-8")) as AiConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** In-memory cache of DB-backed server AI config (non-BYOK). */
let aiServerCache: AiConfig | null = null;
let aiServerLoad: Promise<void> | null = null;

async function persistAiServerConfig(value: AiConfig): Promise<void> {
  const { ensureAdminSchema } = await import("./admin-store");
  const { getAuthPool } = await import("./auth-db");
  await ensureAdminSchema();
  const pool = getAuthPool();
  await pool.query(
    `INSERT INTO app_settings (key, value, "updatedAt")
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, "updatedAt" = NOW()`,
    [AI_SERVER_SETTINGS_KEY, JSON.stringify(value || {})],
  );
  aiServerCache = { ...(value || {}) };
}

/**
 * Load server AI config from Postgres; one-time migrate from legacy file
 * (including /tmp) when the DB row is empty.
 */
export async function ensureAiServerConfigLoaded(): Promise<void> {
  if (isByokOnly()) {
    aiServerCache = {};
    return;
  }
  if (aiServerCache !== null) return;
  if (!aiServerLoad) {
    aiServerLoad = (async () => {
      try {
        const { ensureAdminSchema } = await import("./admin-store");
        const { getAuthPool } = await import("./auth-db");
        await ensureAdminSchema();
        const pool = getAuthPool();
        const { rows } = await pool.query<{ value: AiConfig }>(
          `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
          [AI_SERVER_SETTINGS_KEY],
        );
        let value =
          rows[0]?.value && typeof rows[0].value === "object"
            ? { ...rows[0].value }
            : {};
        const hasDb =
          Boolean(String(value.geminiApiKey || "").trim()) ||
          Boolean(String(value.geminiModel || "").trim());
        if (!hasDb) {
          const legacy = readLegacyFileConfig();
          if (
            String(legacy.geminiApiKey || "").trim() ||
            String(legacy.geminiModel || "").trim()
          ) {
            value = { ...legacy };
            await persistAiServerConfig(value);
          } else {
            aiServerCache = {};
          }
        } else {
          aiServerCache = value;
        }
      } catch {
        // DB unavailable — fall back to legacy file for this process only.
        aiServerCache = readLegacyFileConfig();
      } finally {
        if (aiServerCache === null) aiServerCache = {};
      }
    })().finally(() => {
      aiServerLoad = null;
    });
  }
  await aiServerLoad;
}

export function readAiConfig(): AiConfig {
  if (isByokOnly()) return {};
  if (aiServerCache) return { ...aiServerCache };
  // Cold path before async load: legacy file only (never write back to /tmp).
  return readLegacyFileConfig();
}

export async function writeAiConfig(patch: Partial<AiConfig>): Promise<AiConfig> {
  if (isByokOnly()) {
    // Do not write user keys in web BYOK mode.
    return { ...readAiConfig(), ...patch, geminiApiKey: undefined };
  }
  await ensureAiServerConfigLoaded();
  const next: AiConfig = { ...readAiConfig(), ...patch };
  await persistAiServerConfig(next);
  return { ...next };
}

export async function clearGeminiKey(): Promise<AiConfig> {
  if (isByokOnly()) return {};
  await ensureAiServerConfigLoaded();
  const cur = { ...readAiConfig() };
  delete cur.geminiApiKey;
  await persistAiServerConfig(cur);
  return { ...cur };
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
 * Fill missing personal credentials from shared server keys.
 *
 * 1. X-Ai-Key-Id sent but vault row gone → Cursor env key (even when BYOK-only),
 *    same rule as auth-rejection fallback.
 * 2. No personal key at all + BYOK-only off → Cursor env key, else Gemini
 *    env/DB server key. Any logged-in user (and status/route resolvers) can use
 *    this path; plan quotas stay separate in premium/limits.
 *
 * Never returns the secret to clients — only attaches it for server-side calls.
 */
export function coalesceAiCredentialsWithSharedEnv(
  creds: ResolvedRequestAiCredentials,
): ResolvedRequestAiCredentials {
  if (creds.apiKey && String(creds.apiKey).trim()) return creds;
  const requested = String(creds.requestedKeyId || creds.keyId || "").trim();

  // Missing vault id → Cursor env fallback (allowed even when BYOK-only).
  if (requested) {
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

  // No personal key: shared server key only when BYOK-only is off.
  if (isByokOnly()) return creds;

  const sharedCursor = peekSharedCursorEnvApiKey();
  if (sharedCursor) {
    return {
      provider: "cursor",
      apiKey: sharedCursor,
      model: defaultModelForProvider("cursor"),
      fromUserVault: false,
      usedSharedEnvFallback: true,
    };
  }

  const sharedGemini = getGeminiApiKey(undefined);
  if (sharedGemini) {
    const geminiProvider =
      getAiProvider(creds.provider)?.apiFamily === "gemini"
        ? getAiProvider(creds.provider)!.id
        : "google";
    return {
      provider: geminiProvider,
      apiKey: sharedGemini,
      model: defaultModelForProvider(geminiProvider),
      fromUserVault: false,
      usedSharedEnvFallback: true,
    };
  }

  return creds;
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
 * Cursor API keys commonly start with `crsr_` / `key_`.
 * Never treat these as a Gemini/Google BYOK override — that made
 * resolveEffectiveAiProvider keep admin default=google while the only
 * shared secret was DOCX_FORM_CURSOR_API_KEY (AI_AUTH 400).
 */
export function looksLikeCursorApiKey(raw: string | null | undefined): boolean {
  const k = String(raw || "").trim();
  if (!k) return false;
  return /^(crsr_|key_)/i.test(k);
}

/** Google AI Studio keys commonly start with `AIza`. */
export function looksLikeGeminiApiKey(raw: string | null | undefined): boolean {
  const k = String(raw || "").trim();
  if (!k) return false;
  return /^AIza/i.test(k);
}

/**
 * Resolve API key: per-request override → (if not BYOK) env/file.
 * Override is ignored when it clearly belongs to another provider family.
 */
export function getGeminiApiKey(override?: string | null): string | undefined {
  const o = override && String(override).trim() ? String(override).trim() : "";
  if (o && !looksLikeCursorApiKey(o)) return o;
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
  const o = override && String(override).trim() ? String(override).trim() : "";
  if (o && !looksLikeGeminiApiKey(o)) return o;
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
    /** Human storage label — never leak filesystem paths (DB-backed, not /tmp). */
    configStore: isByokOnly() ? "browser" : "database",
    configStoreLabel: isByokOnly()
      ? "เบราว์เซอร์ (ไม่เก็บบนเซิร์ฟเวอร์)"
      : "เก็บบนเซิร์ฟเวอร์ (ฐานข้อมูล)",
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
