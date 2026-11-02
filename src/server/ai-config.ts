import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultModelForProvider,
  getAiProvider,
  listAiProvidersPublic,
  normalizeProviderModel,
  type AiProviderId,
} from "./ai-providers";

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

function resolveConfigDir(): string {
  const fromEnv = String(process.env.DOCX_FORM_CONFIG_DIR || "").trim();
  if (fromEnv) return fromEnv;

  const home = homedir();
  if (
    home &&
    home !== "/nonexistent" &&
    !home.startsWith("/nonexistent") &&
    // Dynamic home path — do not let Turbopack trace the whole project.
    existsSync(/* turbopackIgnore: true */ home)
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

/** Same path as main; turbopackIgnore avoids whole-project FS tracing. */
function ensureConfigDir(): void {
  if (!existsSync(/* turbopackIgnore: true */ CONFIG_DIR)) {
    mkdirSync(/* turbopackIgnore: true */ CONFIG_DIR, { recursive: true });
  }
}

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
    if (!existsSync(/* turbopackIgnore: true */ CONFIG_PATH)) return {};
    const raw = JSON.parse(
      readFileSync(/* turbopackIgnore: true */ CONFIG_PATH, "utf-8"),
    ) as AiConfig;
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
  ensureConfigDir();
  writeFileSync(
    /* turbopackIgnore: true */ CONFIG_PATH,
    JSON.stringify(next, null, 2),
    "utf-8",
  );
  return next;
}

export function clearGeminiKey(): AiConfig {
  if (isByokOnly()) return {};
  const cur = readAiConfig();
  delete cur.geminiApiKey;
  ensureConfigDir();
  writeFileSync(
    /* turbopackIgnore: true */ CONFIG_PATH,
    JSON.stringify(cur, null, 2),
    "utf-8",
  );
  return cur;
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
 */
export async function resolveRequestAiCredentials(
  req: Request,
  userId?: string | null,
): Promise<RequestAiCredentials & { keyId?: string }> {
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
        };
      }
    } catch {
      /* fall through to header key */
    }
  }
  return { ...base, keyId };
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

export function geminiStatus(opts?: {
  requestKey?: string | null;
  requestModel?: string | null;
  requestProvider?: string | null;
  /** Admin-configured default when file/env has none */
  adminDefaultModel?: string | null;
}) {
  const providerId =
    getAiProvider(opts?.requestProvider)?.id ||
    getAiProvider("google")?.id ||
    "google";
  const provider = getAiProvider(providerId)!;
  const key =
    provider.apiFamily === "gemini"
      ? getGeminiApiKey(opts?.requestKey)
      : opts?.requestKey && String(opts.requestKey).trim()
        ? String(opts.requestKey).trim()
        : undefined;
  const model =
    normalizeProviderModel(providerId, opts?.requestModel) ||
    (provider.apiFamily === "gemini"
      ? normalizeGeminiModel(readAiConfig().geminiModel)
      : null) ||
    (provider.apiFamily === "gemini"
      ? normalizeGeminiModel(opts?.adminDefaultModel)
      : null) ||
    provider.defaultModel;
  return {
    connected: !!key,
    byok: isByokOnly(),
    provider: providerId,
    providerLabel: provider.label,
    apiFamily: provider.apiFamily,
    model,
    models: provider.models,
    defaultModel: provider.defaultModel,
    adminDefaultModel: normalizeGeminiModel(opts?.adminDefaultModel) || null,
    maskedKey: key ? maskGeminiKey(key) : null,
    hasServerEnvKey: !!(
      process.env.DOCX_FORM_GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY
    ),
    premiumEnforce:
      String(process.env.PREMIUM_ENFORCE || "").trim() === "1" ||
      String(process.env.PREMIUM_ENFORCE || "")
        .trim()
        .toLowerCase() === "true",
    configPath: isByokOnly() ? "(browser session — not stored on server)" : CONFIG_PATH,
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
  const key = String(apiKey || "").trim();
  if (!key) return false;
  if (p?.apiFamily === "gemini") return !!getGeminiApiKey(key);
  return key.length >= 8;
}
