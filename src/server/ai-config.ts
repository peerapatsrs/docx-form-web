import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type AiConfig = {
  /** Google AI Studio / Gemini API key — only used when BYOK is off (legacy/local) */
  geminiApiKey?: string;
  geminiModel?: string;
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
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function clearGeminiKey(): AiConfig {
  if (isByokOnly()) return {};
  const cur = readAiConfig();
  delete cur.geminiApiKey;
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), "utf-8");
  return cur;
}

export function maskGeminiKey(key: string): string {
  const k = String(key || "").trim();
  if (k.length < 10) return "••••";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** Key sent by the browser for this request only. */
export function getRequestGeminiKey(req?: Request | null): string | undefined {
  if (!req) return undefined;
  const raw =
    req.headers.get("x-gemini-api-key") ||
    req.headers.get("x-goog-api-key") ||
    "";
  const key = String(raw || "").trim();
  return key || undefined;
}

export function getRequestGeminiModel(req?: Request | null): string | undefined {
  if (!req) return undefined;
  return normalizeGeminiModel(req.headers.get("x-gemini-model")) || undefined;
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

export function geminiStatus(opts?: {
  requestKey?: string | null;
  requestModel?: string | null;
}) {
  const key = getGeminiApiKey(opts?.requestKey);
  const model = getGeminiModel(opts?.requestModel);
  return {
    connected: !!key,
    byok: isByokOnly(),
    provider: "google-gemini" as const,
    model,
    models: GEMINI_MODEL_OPTIONS,
    defaultModel: DEFAULT_GEMINI_MODEL,
    maskedKey: key ? maskGeminiKey(key) : null,
    configPath: isByokOnly() ? "(browser session — not stored on server)" : CONFIG_PATH,
    studioUrl: "https://aistudio.google.com/apikey",
  };
}
