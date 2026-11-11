/**
 * FE adapter for AI key settings — Backend FINAL contract.
 *
 * GET  /api/ai/keys/status  → { mode, serverKeyAvailable, userKeySet, userKeyHint? }
 * PUT  /api/ai/keys/status  → same (bodies: {mode} | {apiKey,provider?,…} | {deleteKey:true})
 * GET  /api/ai/keys/models  → { models:[{id,label,provider,source}], mode, … }
 *
 * Never returns, logs, or requests the system/server key value.
 * Mode is persisted via PUT only (no localStorage mode fallback).
 */

export type AiKeySettingsMode = "server" | "byok";

export type AiKeySettingsState = {
  mode: AiKeySettingsMode;
  serverKeyAvailable: boolean;
  userKeySet: boolean;
  userKeyHint?: string;
};

export type AiKeyModelRow = {
  id: string;
  label: string;
  provider: string;
  source: "server" | "byok";
};

export type AiKeyModelsResponse = AiKeySettingsState & {
  models: AiKeyModelRow[];
};

export type AiKeySettingsApiError = {
  ok: false;
  error: string;
  code: string;
  status: number;
};

/** Playwright / local verify only. */
declare global {
  interface Window {
    __DOCX_FORM_AI_KEY_SETTINGS_MOCK__?: Partial<AiKeySettingsState> & {
      force?: boolean;
      models?: AiKeyModelRow[];
    };
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function maskHint(raw: string | undefined | null): string | undefined {
  const s = String(raw || "").trim();
  if (!s) return undefined;
  if (/[•*]/.test(s) || s.includes("…")) return s.slice(0, 24);
  if (s.length <= 4) return `••••${s}`;
  return `••••${s.slice(-4)}`;
}

function parseMode(raw: unknown): AiKeySettingsMode {
  const m = String(raw || "").trim();
  if (m === "server") return "server";
  if (m === "byok" || m === "own" || m === "user") return "byok";
  return "server";
}

/** Normalize GET/PUT /api/ai/keys/status (or models) payload. */
export function normalizeAiKeySettingsState(raw: unknown): AiKeySettingsState {
  const body = asRecord(raw);
  const hint = maskHint(
    typeof body.userKeyHint === "string" ? body.userKeyHint : null,
  );
  return {
    mode: parseMode(body.mode),
    serverKeyAvailable: Boolean(body.serverKeyAvailable),
    userKeySet: Boolean(body.userKeySet),
    ...(hint ? { userKeyHint: hint } : {}),
  };
}

export function normalizeAiKeyModelsResponse(raw: unknown): AiKeyModelsResponse {
  const body = asRecord(raw);
  const state = normalizeAiKeySettingsState(body);
  const modelsIn = Array.isArray(body.models) ? body.models : [];
  const models: AiKeyModelRow[] = [];
  for (const row of modelsIn) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id || "").trim();
    if (!id) continue;
    const source = r.source === "server" ? "server" : "byok";
    models.push({
      id,
      label: String(r.label || id).trim() || id,
      provider: String(r.provider || "google").trim() || "google",
      source,
    });
  }
  return { ...state, models };
}

/** Empty / disabled group reasons for the model picker. */
export function buildAiModelPickerGroupsFromModels(
  data: AiKeyModelsResponse,
): {
  groups: {
    id: "server" | "byok";
    label: string;
    disabled: boolean;
    reason?: string;
    options: { id: string; label: string; source: "server" | "byok"; provider?: string }[];
  }[];
} {
  const serverModels = data.models.filter((m) => m.source === "server");
  const byokModels = data.models.filter((m) => m.source === "byok");
  const serverDisabled = !data.serverKeyAvailable || serverModels.length === 0;
  const byokDisabled = !data.userKeySet || byokModels.length === 0;
  return {
    groups: [
      {
        id: "server",
        label: "คีย์กลางของระบบ",
        disabled: serverDisabled,
        reason: !data.serverKeyAvailable
          ? "ระบบยังไม่ได้ตั้งคีย์กลาง"
          : serverModels.length === 0
            ? "ยังไม่มีโมเดลจากคีย์กลาง"
            : undefined,
        options: serverDisabled
          ? []
          : serverModels.map((m) => ({
              id: m.id,
              label: m.label,
              source: "server" as const,
              provider: m.provider,
            })),
      },
      {
        id: "byok",
        label: "คีย์ของฉัน",
        disabled: byokDisabled,
        reason: !data.userKeySet
          ? "ยังไม่ได้บันทึกคีย์ของฉัน"
          : byokModels.length === 0
            ? "ยังไม่มีโมเดลจากคีย์ของฉัน"
            : undefined,
        options: byokDisabled
          ? []
          : byokModels.map((m) => ({
              id: m.id,
              label: m.label,
              source: "byok" as const,
              provider: m.provider,
            })),
      },
    ],
  };
}

function readMock():
  | (Partial<AiKeySettingsState> & { force?: boolean; models?: AiKeyModelRow[] })
  | null {
  if (typeof window === "undefined") return null;
  try {
    return window.__DOCX_FORM_AI_KEY_SETTINGS_MOCK__ || null;
  } catch {
    return null;
  }
}

export async function fetchAiKeySettingsState(): Promise<AiKeySettingsState> {
  const mock = readMock();
  if (mock?.force) {
    return normalizeAiKeySettingsState({
      mode: mock.mode ?? "server",
      serverKeyAvailable: mock.serverKeyAvailable ?? false,
      userKeySet: mock.userKeySet ?? false,
      userKeyHint: mock.userKeyHint,
    });
  }

  const res = await fetch("/api/ai/keys/status", { credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const err = new Error(
      typeof body.error === "string" ? body.error : "AI_KEY_UNAUTHORIZED",
    ) as Error & { code?: string; status?: number };
    err.code = String(body.code || "AI_KEY_UNAUTHORIZED");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(
      typeof body.error === "string" ? body.error : "AI_KEY_SERVER_ERROR",
    ) as Error & { code?: string; status?: number };
    err.code = String(body.code || "AI_KEY_SERVER_ERROR");
    err.status = res.status;
    throw err;
  }
  let state = normalizeAiKeySettingsState(body);
  if (mock) {
    state = {
      ...state,
      ...(mock.mode === "server" || mock.mode === "byok" ? { mode: mock.mode } : null),
      ...(typeof mock.serverKeyAvailable === "boolean"
        ? { serverKeyAvailable: mock.serverKeyAvailable }
        : null),
      ...(typeof mock.userKeySet === "boolean" ? { userKeySet: mock.userKeySet } : null),
      ...(mock.userKeyHint !== undefined
        ? { userKeyHint: maskHint(mock.userKeyHint) }
        : null),
    };
  }
  return state;
}

export async function fetchAiKeyModels(): Promise<AiKeyModelsResponse> {
  const mock = readMock();
  if (mock?.force) {
    const state = normalizeAiKeySettingsState({
      mode: mock.mode ?? "server",
      serverKeyAvailable: mock.serverKeyAvailable ?? false,
      userKeySet: mock.userKeySet ?? false,
      userKeyHint: mock.userKeyHint,
    });
    return {
      ...state,
      models: Array.isArray(mock.models) ? mock.models : [],
    };
  }

  const res = await fetch("/api/ai/keys/models", { credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const err = new Error(
      typeof body.error === "string" ? body.error : "AI_KEY_UNAUTHORIZED",
    ) as Error & { code?: string; status?: number };
    err.code = "AI_KEY_UNAUTHORIZED";
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(
      typeof body.error === "string" ? body.error : "AI_KEY_SERVER_ERROR",
    ) as Error & { code?: string; status?: number };
    err.code = String(body.code || "AI_KEY_SERVER_ERROR");
    err.status = res.status;
    throw err;
  }
  return normalizeAiKeyModelsResponse(body);
}

export type AiKeySettingsPutBody =
  | { mode: AiKeySettingsMode }
  | { apiKey: string; provider?: string; label?: string; model?: string }
  | { deleteKey: true };

/**
 * PUT /api/ai/keys/status — persists mode, saves user key, or deletes all user keys.
 */
export async function putAiKeySettings(
  body: AiKeySettingsPutBody,
): Promise<
  | { ok: true; state: AiKeySettingsState }
  | AiKeySettingsApiError
> {
  const mock = readMock();
  if (mock?.force) {
    if ("mode" in body) {
      return {
        ok: true,
        state: normalizeAiKeySettingsState({
          mode: body.mode,
          serverKeyAvailable: mock.serverKeyAvailable ?? false,
          userKeySet: mock.userKeySet ?? false,
          userKeyHint: mock.userKeyHint,
        }),
      };
    }
    if ("deleteKey" in body) {
      return {
        ok: true,
        state: normalizeAiKeySettingsState({
          mode: mock.mode ?? "byok",
          serverKeyAvailable: mock.serverKeyAvailable ?? false,
          userKeySet: false,
        }),
      };
    }
    if ("apiKey" in body) {
      const key = String(body.apiKey || "").trim();
      if (key.length < 8) {
        return {
          ok: false,
          error: "คีย์สั้นเกินไปหรือว่าง",
          code: "AI_KEY_INVALID",
          status: 400,
        };
      }
      return {
        ok: true,
        state: normalizeAiKeySettingsState({
          mode: "byok",
          serverKeyAvailable: mock.serverKeyAvailable ?? false,
          userKeySet: true,
          userKeyHint: maskHint(key),
        }),
      };
    }
  }

  try {
    const res = await fetch("/api/ai/keys/status", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === "string" ? data.error : "AI_KEY_SERVER_ERROR",
        code: String(data.code || (res.status === 401 ? "AI_KEY_UNAUTHORIZED" : "AI_KEY_SERVER_ERROR")),
        status: res.status,
      };
    }
    return { ok: true, state: normalizeAiKeySettingsState(data) };
  } catch {
    return {
      ok: false,
      error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้",
      code: "AI_KEY_SERVER_ERROR",
      status: 0,
    };
  }
}

/** @deprecated use putAiKeySettings({ mode }) */
export async function updateAiKeySettingsMode(mode: AiKeySettingsMode) {
  return putAiKeySettings({ mode });
}

/** @deprecated use putAiKeySettings({ apiKey, provider }) */
export async function saveUserAiKey(apiKey: string) {
  return putAiKeySettings({
    apiKey,
    provider: "google",
    label: "คีย์ของฉัน",
    model: "gemini-3.8-flash",
  });
}

/** @deprecated use putAiKeySettings({ deleteKey: true }) */
export async function deleteUserAiKey() {
  return putAiKeySettings({ deleteKey: true });
}

/**
 * Append AI request wiring fields for suggest-tags / source-map / batch-from-source.
 * Does not gate; callers decide when to send.
 */
export function appendAiKeyRequestFields(
  fd: FormData,
  opts: {
    source?: "server" | "byok" | string | null;
    aiModel?: string | null;
    aiProvider?: string | null;
  },
): { source: "server" | "byok"; aiModel: string; aiProvider: string } {
  const source = opts.source === "server" ? "server" : "byok";
  const aiModel = String(opts.aiModel || "").trim();
  const aiProvider = String(opts.aiProvider || "").trim();
  fd.append("source", source);
  if (aiModel) {
    fd.append("aiModel", aiModel);
    fd.append("geminiModel", aiModel);
  }
  if (aiProvider) fd.append("aiProvider", aiProvider);
  return { source, aiModel, aiProvider };
}
