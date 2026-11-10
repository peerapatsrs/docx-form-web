/**
 * BYOK provider registry — browser stores keys; server proxies by apiFamily.
 *
 * URLs override via env (optional):
 *   AI_PROVIDER_<ID>_BASE_URL  e.g. AI_PROVIDER_XAI_BASE_URL
 *   AI_PROVIDER_<ID>_DOCS_URL
 *   AI_GEMINI_API_BASE         (default https://generativelanguage.googleapis.com)
 *   AI_ANTHROPIC_API_BASE      (default https://api.anthropic.com)
 */

export type AiApiFamily = "gemini" | "openai" | "anthropic" | "cursor";

export type AiProviderId =
  | "google"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "deepseek"
  | "groq"
  | "xai"
  | "mistral"
  | "cursor";

export type AiModelOption = { id: string; label: string };

export type AiProviderDef = {
  id: AiProviderId;
  label: string;
  apiFamily: AiApiFamily;
  docsUrl: string;
  /** Chat Completions / Messages base (unused for gemini) */
  baseUrl?: string;
  /** Extra headers for OpenAI-compatible gateways */
  defaultHeaders?: Record<string, string>;
  models: AiModelOption[];
  defaultModel: string;
  /** Placeholder hint for API key field */
  keyPlaceholder?: string;
  /**
   * When false, BYOK keys may be stored for future use but must not be used
   * for tagger draft / form fill (no OpenAI-compatible chat completions).
   * Default: true.
   */
  formAiSupported?: boolean;
  /** Short Thai note shown when formAiSupported is false */
  formAiNote?: string;
};

/** Thai banner when a provider cannot power tagger/fill. */
export function formAiUnsupportedMessage(provider: AiProviderDef): string {
  if (provider.formAiNote) return provider.formAiNote;
  return `${provider.label}: ยังไม่รองรับ AI ดราฟตัวแปร/กรอกฟอร์มในแอปนี้ — ใช้ Gemini / OpenAI / Claude แทน`;
}

export function assertFormAiSupported(provider: AiProviderDef): void {
  if (provider.formAiSupported === false) {
    throw new Error(formAiUnsupportedMessage(provider));
  }
}

function envUrl(name: string, fallback: string): string {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

function stripTrailingSlash(url: string): string {
  return String(url || "").replace(/\/+$/, "");
}

/** Google Generative Language API host (no path). */
export function getGeminiApiBase(): string {
  return stripTrailingSlash(
    envUrl(
      "AI_GEMINI_API_BASE",
      "https://generativelanguage.googleapis.com",
    ),
  );
}

/** Anthropic API host (no /v1). */
export function getAnthropicApiBase(): string {
  return stripTrailingSlash(
    envUrl("AI_ANTHROPIC_API_BASE", "https://api.anthropic.com"),
  );
}

const AI_PROVIDERS_DEFAULT: AiProviderDef[] = [
  {
    id: "google",
    label: "Google Gemini",
    apiFamily: "gemini",
    docsUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    defaultModel: "gemini-3.8-flash",
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (แนะนำ)" },
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)" },
      { id: "gemini-flash-latest", label: "gemini-flash-latest" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    apiFamily: "openai",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    defaultModel: "gpt-4.1-mini",
    models: [
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini (แนะนำ)" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "o4-mini", label: "o4-mini" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    apiFamily: "anthropic",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    defaultModel: "claude-sonnet-4-5",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 (แนะนำ)" },
      { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet (latest)" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku (latest)" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    apiFamily: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
    defaultHeaders: {
      "HTTP-Referer": "https://docx-form.local",
      "X-Title": "docx-form-web",
    },
    defaultModel: "openai/gpt-4.1-mini",
    models: [
      { id: "openai/gpt-4.1-mini", label: "OpenAI GPT-4.1 mini" },
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiFamily: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    docsUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
    defaultModel: "deepseek-chat",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat (แนะนำ)" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    apiFamily: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    docsUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (แนะนำ)" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant" },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout" },
    ],
  },
  {
    id: "xai",
    label: "xAI Grok",
    apiFamily: "openai",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://console.x.ai/",
    keyPlaceholder: "xai-…",
    defaultModel: "grok-2-latest",
    models: [
      { id: "grok-2-latest", label: "Grok 2 (แนะนำ)" },
      { id: "grok-2-vision-latest", label: "Grok 2 Vision" },
    ],
  },
  {
    id: "mistral",
    label: "Mistral",
    apiFamily: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    docsUrl: "https://console.mistral.ai/api-keys",
    keyPlaceholder: "…",
    defaultModel: "mistral-small-latest",
    models: [
      { id: "mistral-small-latest", label: "Mistral Small (แนะนำ)" },
      { id: "mistral-medium-latest", label: "Mistral Medium" },
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "pixtral-large-latest", label: "Pixtral Large" },
    ],
  },
  /**
   * Cursor — API keys (crsr_…) จาก Dashboard → API Keys.
   * Form AI ใช้ @cursor/sdk Cloud Agent แบบ no-repo (`cloud: { repos: [] }`)
   * ใส่ข้อความเอกสารใน prompt แล้ว parse JSON จาก result.result
   * (ไม่ใช่ OpenAI-compatible chat completions — ช้าและคิดเงินตามแพ็กเกจ Cursor)
   * @see https://cursor.com/docs/sdk/typescript
   */
  {
    id: "cursor",
    label: "Cursor",
    apiFamily: "cursor",
    // Unused by form AI (SDK cloud path); kept for env override / docs only.
    baseUrl: "https://api.cursor.com/v1",
    docsUrl: "https://cursor.com/docs/sdk/typescript",
    keyPlaceholder: "crsr_…",
    formAiSupported: true,
    formAiNote:
      "Cursor: ใช้ Cloud Agent (no-repo) ผ่าน SDK — ช้ากว่า chat ปกติ และคิดเงินตามแพ็กเกจ Cursor",
    // Static fallback only — live catalog comes from Cursor.models.list().
    // Do not hardcode account-gated ids like auto-smart (Teams+/Router).
    defaultModel: "composer-2.5",
    models: [
      { id: "composer-2.5", label: "Composer 2.5 (แนะนำ)" },
    ],
  },
];

/** Model ids that often linger in vaults but are gated / retired / aliases. */
export const CURSOR_STALE_MODEL_IDS = new Set([
  "auto-smart",
  "auto",
  "default",
  "composer-2",
  "composer-2-fast",
]);

/**
 * Map a vault / header model to one safe for Agent.create.
 * Stale or empty ids fall back to the Cursor registry default.
 */
export function resolveCursorModelId(
  raw: string | null | undefined,
  availableIds?: Iterable<string> | null,
): string {
  const provider = getAiProvider("cursor");
  const fallback = provider?.defaultModel || "composer-2.5";
  const id = String(raw || "").trim();
  const availableList = availableIds
    ? [...availableIds]
        .map((x) => String(x || "").trim())
        .filter((x) => x && !CURSOR_STALE_MODEL_IDS.has(x))
    : null;
  const available = availableList ? new Set(availableList) : null;

  // Router / alias ids need params or team access — never send as bare id.
  const wantsRemap = !id || CURSOR_STALE_MODEL_IDS.has(id);

  if (available) {
    if (!wantsRemap && available.has(id)) return id;
    if (available.has(fallback)) return fallback;
    return availableList![0] || fallback;
  }

  if (wantsRemap) return fallback;
  if (provider?.models.some((m) => m.id === id)) return id;
  // Unknown id — still pass through (live catalog may accept it); caller
  // can remap again after Cursor.models.list() when a key is present.
  return id;
}

function applyEnvUrls(p: AiProviderDef): AiProviderDef {
  const key = p.id.toUpperCase();
  const baseFallback =
    p.id === "anthropic" ? getAnthropicApiBase() : p.baseUrl || "";
  const baseUrlRaw = p.baseUrl
    ? envUrl(`AI_PROVIDER_${key}_BASE_URL`, baseFallback)
    : undefined;
  const docsUrl = envUrl(`AI_PROVIDER_${key}_DOCS_URL`, p.docsUrl);
  return {
    ...p,
    docsUrl,
    baseUrl: baseUrlRaw ? stripTrailingSlash(baseUrlRaw) : undefined,
  };
}

/** Live registry with env URL overrides applied. */
export function listAiProviders(): AiProviderDef[] {
  return AI_PROVIDERS_DEFAULT.map(applyEnvUrls);
}

/** @deprecated prefer listAiProviders() — kept for imports that expect a const */
export const AI_PROVIDERS: AiProviderDef[] = AI_PROVIDERS_DEFAULT;

export function getAiProvider(id: string | null | undefined): AiProviderDef | null {
  const key = String(id || "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  const resolved =
    key === "google-gemini" || key === "gemini" ? "google" : key;
  const base = AI_PROVIDERS_DEFAULT.find((p) => p.id === resolved);
  return base ? applyEnvUrls(base) : null;
}

export function listAiProvidersPublic() {
  return listAiProviders().map((p) => ({
    id: p.id,
    label: p.label,
    apiFamily: p.apiFamily,
    docsUrl: p.docsUrl,
    defaultModel: p.defaultModel,
    models: p.models,
    keyPlaceholder: p.keyPlaceholder || "",
    formAiSupported: p.formAiSupported !== false,
    formAiNote: p.formAiNote || "",
  }));
}

export function normalizeProviderModel(
  providerId: string | null | undefined,
  raw: unknown,
): string | null {
  const provider = getAiProvider(providerId) || getAiProvider("google");
  const id = String(raw || "").trim();
  if (!id) return null;
  // OpenRouter / vendor models may include "/"
  if (!/^[a-zA-Z0-9._/:+\-]+$/.test(id)) return null;
  if (id.length > 120) return null;
  if (provider) {
    const known = provider.models.some((m) => m.id === id);
    if (known) return id;
  }
  return id;
}

export function defaultModelForProvider(providerId: string | null | undefined): string {
  const p = getAiProvider(providerId);
  return p?.defaultModel || "gemini-3.8-flash";
}

/**
 * Model the server will actually send for this provider — same remap rules as
 * fill/tag calls (Cursor stale/cross-family ids → registry default).
 * Use this for status pills /admin displays so the label matches the call.
 *
 * For Cursor, pass the static catalog as the availability set so unknown
 * leftovers like `gemini-3.8-flash` remap to `composer-2.5` the same way
 * `resolveCursorModelForCall` does once the live list is loaded.
 */
export function resolveEffectiveModelForProvider(
  providerId: string | null | undefined,
  raw: unknown,
): string {
  const provider = getAiProvider(providerId) || getAiProvider("google");
  const normalized = normalizeProviderModel(providerId, raw);
  if (provider?.apiFamily === "cursor") {
    const catalogIds = provider.models.map((m) => m.id);
    return resolveCursorModelId(
      normalized || String(raw || ""),
      catalogIds.length ? catalogIds : null,
    );
  }
  if (normalized) {
    // Cross-family leftovers (e.g. gemini id while effective provider is openai)
    // fall through to that provider's default when not in its static catalog and
    // the catalog is non-empty.
    if (
      provider &&
      provider.models.length > 0 &&
      !provider.models.some((m) => m.id === normalized)
    ) {
      return provider.defaultModel;
    }
    return normalized;
  }
  return provider?.defaultModel || defaultModelForProvider(providerId);
}
