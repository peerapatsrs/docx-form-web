/**
 * Live model lists from provider APIs (fallback to registry defaults).
 */

import { Cursor } from "@cursor/sdk";
import {
  getAiProvider,
  getAnthropicApiBase,
  getGeminiApiBase,
  resolveCursorModelId,
  type AiModelOption,
  type AiProviderDef,
} from "./ai-providers";
import { formatModelsListError } from "./ai-http-errors";

function niceLabel(id: string): string {
  const s = String(id || "").trim();
  if (!s) return s;
  return s
    .replace(/^models\//i, "")
    .replace(/[:/]/g, " · ")
    .replace(/-/g, " ");
}

/** Short Thai hint for UI — shared mapper (never invents credits blame). */
export function friendlyModelsError(
  providerLabel: string,
  status: number,
  body: string,
): string {
  return formatModelsListError(providerLabel, status, body);
}

function dedupeModels(list: AiModelOption[]): AiModelOption[] {
  const seen = new Set<string>();
  const out: AiModelOption[] = [];
  for (const m of list) {
    const id = String(m.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: m.label || niceLabel(id) });
  }
  return out;
}

async function fetchGeminiModels(apiKey: string): Promise<AiModelOption[]> {
  const url = `${getGeminiApiBase()}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(friendlyModelsError("Google Gemini", res.status, t));
  }
  const data = (await res.json()) as {
    models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  };
  const out: AiModelOption[] = [];
  for (const m of data.models || []) {
    const methods = m.supportedGenerationMethods || [];
    if (methods.length && !methods.includes("generateContent")) continue;
    const raw = String(m.name || "").replace(/^models\//i, "");
    if (!raw || !/gemini|flash|pro|gemma/i.test(raw)) continue;
    out.push({
      id: raw,
      label: m.displayName ? `${m.displayName} (${raw})` : niceLabel(raw),
    });
  }
  return out;
}

async function fetchOpenAiCompatModels(
  provider: AiProviderDef,
  apiKey: string,
): Promise<AiModelOption[]> {
  if (!provider.baseUrl) throw new Error("ไม่มี baseUrl");
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(provider.defaultHeaders || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(friendlyModelsError(provider.label, res.status, t));
  }
  const data = (await res.json()) as {
    data?: { id?: string; object?: string }[];
  };
  let ids = (data.data || [])
    .map((m) => String(m.id || "").trim())
    .filter(Boolean);

  // Prefer chat-ish models; keep full list if filter empties.
  const chatish = ids.filter((id) => {
    const low = id.toLowerCase();
    if (/embedding|whisper|tts|dall-e|moderation|realtime|transcribe|image/i.test(low)) {
      return false;
    }
    return true;
  });
  if (chatish.length) ids = chatish;

  // Soft cap for huge catalogs (OpenRouter).
  if (ids.length > 80) {
    const preferred = provider.models.map((m) => m.id);
    const head = [
      ...preferred.filter((id) => ids.includes(id)),
      ...ids.filter((id) => !preferred.includes(id)),
    ].slice(0, 80);
    ids = head;
  }

  return ids.map((id) => {
    const known = provider.models.find((m) => m.id === id);
    return { id, label: known?.label || niceLabel(id) };
  });
}

async function fetchAnthropicModels(apiKey: string): Promise<AiModelOption[]> {
  const res = await fetch(`${getAnthropicApiBase()}/v1/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(friendlyModelsError("Anthropic", res.status, t));
  }
  const data = (await res.json()) as {
    data?: { id?: string; display_name?: string }[];
  };
  return (data.data || [])
    .map((m) => {
      const id = String(m.id || "").trim();
      if (!id) return null;
      return {
        id,
        label: m.display_name ? `${m.display_name} (${id})` : niceLabel(id),
      };
    })
    .filter(Boolean) as AiModelOption[];
}

async function fetchCursorModels(apiKey: string): Promise<AiModelOption[]> {
  try {
    const models = await Cursor.models.list({ apiKey });
    const out: AiModelOption[] = [];
    for (const m of models || []) {
      const id = String(m?.id || "").trim();
      if (!id) continue;
      // Router needs optimize_for params — skip for form AI picker simplicity.
      // Teams with Router can still use it from Cursor IDE; vault stale
      // auto-smart is remapped on agent call.
      if (id === "auto-smart" || id === "auto" || id === "default") continue;
      const display = String(m.displayName || "").trim();
      out.push({
        id,
        label: display ? `${display} (${id})` : niceLabel(id),
      });
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(friendlyModelsError("Cursor", 0, msg));
  }
}

/**
 * Fetch live models; on failure returns registry defaults (source: "fallback").
 */
export async function listProviderModels(opts: {
  provider: string;
  apiKey: string;
}): Promise<{
  models: AiModelOption[];
  defaultModel: string;
  source: "live" | "fallback";
  error?: string;
  providerLabel: string;
}> {
  const provider = getAiProvider(opts.provider) || getAiProvider("google")!;
  const apiKey = String(opts.apiKey || "").trim();
  const fallback = {
    models: provider.models.slice(),
    defaultModel: provider.defaultModel,
    source: "fallback" as const,
    providerLabel: provider.label,
  };
  if (!apiKey) {
    return { ...fallback, error: "ต้องส่ง apiKey" };
  }

  // Providers without form AI have no chat /models catalog.
  if (provider.formAiSupported === false) {
    return {
      ...fallback,
      error:
        provider.formAiNote ||
        `${provider.label}: ยังไม่มีรายการโมเดลแบบ chat completions`,
    };
  }

  try {
    let models: AiModelOption[] = [];
    if (provider.apiFamily === "cursor") {
      models = await fetchCursorModels(apiKey);
    } else if (provider.apiFamily === "gemini") {
      models = await fetchGeminiModels(apiKey);
    } else if (provider.apiFamily === "anthropic") {
      models = await fetchAnthropicModels(apiKey);
    } else {
      models = await fetchOpenAiCompatModels(provider, apiKey);
    }
    models = dedupeModels(models);
    if (!models.length) {
      return { ...fallback, error: "API ไม่คืนรายการโมเดล — ใช้รายการสำรอง" };
    }
    // Put registry default first when present.
    const def =
      provider.apiFamily === "cursor"
        ? resolveCursorModelId(
            provider.defaultModel,
            models.map((m) => m.id),
          )
        : provider.defaultModel;
    if (def && models.some((m) => m.id === def)) {
      models = [
        ...models.filter((m) => m.id === def),
        ...models.filter((m) => m.id !== def),
      ];
    } else if (def && !models.some((m) => m.id === def)) {
      models = [{ id: def, label: `${niceLabel(def)} (ค่าเริ่มต้น)` }, ...models];
    }
    return {
      models,
      defaultModel: models.some((m) => m.id === def) ? def : models[0].id,
      source: "live",
      providerLabel: provider.label,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...fallback, error: message };
  }
}
