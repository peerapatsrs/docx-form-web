/**
 * FE adapter for AI key settings (account page).
 *
 * Target Backend state (non-secret):
 *   { mode: 'server'|'byok', serverKeyAvailable: boolean, userKeySet: boolean, userKeyHint?: string }
 *
 * Reads existing /api/ai/status + /api/ai/keys today and normalizes into that shape.
 * Mode preference falls back to localStorage until Backend persists `mode`.
 * Never returns, logs, or requests the system/server key value.
 */

export type AiKeySettingsMode = "server" | "byok";

export type AiKeySettingsState = {
  mode: AiKeySettingsMode;
  serverKeyAvailable: boolean;
  /** True when availability is known from the API; false when field was missing. */
  serverKeyAvailabilityKnown: boolean;
  userKeySet: boolean;
  userKeyHint?: string;
};

export type AiKeySettingsUpdate =
  | { mode: AiKeySettingsMode }
  | { mode: "byok"; userApiKey: string }
  | { mode: "byok"; clearUserKey: true };

const MODE_LS = "docx-form-web:aiKeyMode:v1";

/** Playwright / local verify only. */
declare global {
  interface Window {
    __DOCX_FORM_AI_KEY_SETTINGS_MOCK__?: Partial<AiKeySettingsState> & {
      /** When set, fetchAiKeySettingsState returns this mock and skips network. */
      force?: boolean;
    };
  }
}

function readLocalMode(): AiKeySettingsMode | null {
  try {
    const raw = String(localStorage.getItem(MODE_LS) || "").trim();
    if (raw === "server" || raw === "byok") return raw;
  } catch {
    /* private mode */
  }
  return null;
}

function writeLocalMode(mode: AiKeySettingsMode): void {
  try {
    localStorage.setItem(MODE_LS, mode);
  } catch {
    /* private mode */
  }
}

function maskHint(raw: string | undefined | null): string | undefined {
  const s = String(raw || "").trim();
  if (!s) return undefined;
  // Already masked (••••1234) — keep. Never invent a system key.
  if (/[•*]/.test(s) || s.includes("…")) return s.slice(0, 24);
  if (s.length <= 4) return `••••${s}`;
  return `••••${s.slice(-4)}`;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * Normalize any status/keys payload into Backend's settings shape.
 * Missing `serverKeyAvailable` → treat as unknown (do not block server choice).
 */
export function normalizeAiKeySettingsState(
  statusRaw: unknown,
  keysRaw?: unknown,
  opts?: { preferredMode?: AiKeySettingsMode | null },
): AiKeySettingsState {
  const status = asRecord(statusRaw);
  const keysBody = asRecord(keysRaw);

  const serverKeyAvailableRaw =
    status.serverKeyAvailable ?? status.serverAiKeyConfigured;
  const serverKeyAvailabilityKnown = typeof serverKeyAvailableRaw === "boolean";
  const serverKeyAvailable = serverKeyAvailabilityKnown
    ? Boolean(serverKeyAvailableRaw)
    : status.keySource === "shared"
      ? true
      : Array.isArray(status.serverKeySources) &&
          (status.serverKeySources as unknown[]).length > 0
        ? true
        : false;

  const entries = Array.isArray(keysBody.entries)
    ? (keysBody.entries as Record<string, unknown>[])
    : Array.isArray(keysRaw)
      ? (keysRaw as Record<string, unknown>[])
      : [];

  let userKeyHint: string | undefined;
  let userKeySet = false;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const hint = maskHint(
      String(e.maskedKey || e.hint || e.userKeyHint || "").trim() || null,
    );
    if (hint || e.hasKey !== false) {
      userKeySet = true;
      if (hint) userKeyHint = hint;
      break;
    }
  }
  if (!userKeySet && status.keySource === "user") {
    userKeySet = true;
    userKeyHint = maskHint(String(status.maskedKey || "").trim() || null);
  }
  if (!userKeyHint && typeof status.userKeyHint === "string") {
    userKeyHint = maskHint(status.userKeyHint);
  }

  let mode: AiKeySettingsMode = "server";
  const statusMode = String(status.mode || "").trim();
  if (statusMode === "server" || statusMode === "byok") {
    mode = statusMode;
  } else if (statusMode === "own" || statusMode === "user") {
    // Legacy aliases from earlier drafts.
    mode = "byok";
  } else if (opts?.preferredMode === "server" || opts?.preferredMode === "byok") {
    mode = opts.preferredMode;
  } else if (userKeySet && !serverKeyAvailable) {
    mode = "byok";
  } else if (!userKeySet && serverKeyAvailable) {
    mode = "server";
  } else if (userKeySet) {
    mode = "byok";
  }

  return {
    mode,
    serverKeyAvailable,
    serverKeyAvailabilityKnown,
    userKeySet,
    userKeyHint,
  };
}

export async function fetchAiKeySettingsState(): Promise<AiKeySettingsState> {
  if (typeof window !== "undefined") {
    const mock = window.__DOCX_FORM_AI_KEY_SETTINGS_MOCK__;
    if (mock?.force) {
      return normalizeAiKeySettingsState(
        {
          mode: mock.mode ?? "server",
          serverKeyAvailable: mock.serverKeyAvailable ?? false,
          userKeySet: mock.userKeySet ?? false,
          userKeyHint: mock.userKeyHint,
        },
        { entries: [] },
        { preferredMode: mock.mode === "server" || mock.mode === "byok" ? mock.mode : null },
      );
    }
  }

  const preferredMode = readLocalMode();
  let statusJson: unknown = {};
  let keysJson: unknown = { entries: [] };

  try {
    const statusRes = await fetch("/api/ai/status", { credentials: "include" });
    statusJson = await statusRes.json().catch(() => ({}));
  } catch {
    statusJson = {};
  }

  try {
    const keysRes = await fetch("/api/ai/keys", { credentials: "include" });
    if (keysRes.ok) {
      keysJson = await keysRes.json().catch(() => ({ entries: [] }));
    }
  } catch {
    keysJson = { entries: [] };
  }

  const state = normalizeAiKeySettingsState(statusJson, keysJson, {
    preferredMode,
  });

  if (typeof window !== "undefined") {
    const mock = window.__DOCX_FORM_AI_KEY_SETTINGS_MOCK__;
    if (mock && !mock.force) {
      return {
        ...state,
        ...(typeof mock.mode === "string" &&
        (mock.mode === "server" || mock.mode === "byok")
          ? { mode: mock.mode }
          : null),
        ...(typeof mock.serverKeyAvailable === "boolean"
          ? {
              serverKeyAvailable: mock.serverKeyAvailable,
              serverKeyAvailabilityKnown: true,
            }
          : null),
        ...(typeof mock.userKeySet === "boolean"
          ? { userKeySet: mock.userKeySet }
          : null),
        ...(mock.userKeyHint !== undefined
          ? { userKeyHint: maskHint(mock.userKeyHint) }
          : null),
      };
    }
  }

  return state;
}

/**
 * Prefer Backend mode endpoint when present; otherwise persist locally.
 * Never sends or requests a system key value.
 */
export async function updateAiKeySettingsMode(
  mode: AiKeySettingsMode,
): Promise<{ ok: true; state: AiKeySettingsState } | { ok: false; error: string }> {
  writeLocalMode(mode);

  try {
    const res = await fetch("/api/ai/key-settings", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const state = normalizeAiKeySettingsState(body, body, { preferredMode: mode });
      return { ok: true, state: { ...state, mode } };
    }
    // 404/405 → endpoint not shipped yet; local mode is enough.
    // Other errors: still keep local preference so UI stays usable.
    if (res.status !== 404 && res.status !== 405) {
      const state = await fetchAiKeySettingsState();
      return { ok: true, state: { ...state, mode } };
    }
  } catch {
    /* offline — local only */
  }

  const state = await fetchAiKeySettingsState();
  return { ok: true, state: { ...state, mode } };
}

export async function saveUserAiKey(apiKey: string): Promise<
  | { ok: true; state: AiKeySettingsState }
  | { ok: false; error: string }
> {
  const key = String(apiKey || "").trim();
  if (key.length < 8) {
    return { ok: false, error: "คีย์สั้นเกินไปหรือว่าง" };
  }
  try {
    const res = await fetch("/api/ai/keys", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: {
          provider: "google",
          label: "คีย์ของฉัน",
          model: "gemini-3.8-flash",
          apiKey: key,
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error:
          typeof body.error === "string"
            ? body.error
            : "บันทึกคีย์ไม่สำเร็จ",
      };
    }
  } catch {
    // Guest / offline: store masked hint only in local vault-ish preference.
    try {
      const vaultRaw = localStorage.getItem("docx-form-web:aiVault:v1");
      const vault = vaultRaw ? JSON.parse(vaultRaw) : { entries: [], activeId: null };
      const id = `k-local-${Date.now().toString(36)}`;
      const entry = {
        id,
        provider: "google",
        label: "คีย์ของฉัน",
        model: "gemini-3.8-flash",
        apiKey: key,
        maskedKey: maskHint(key),
        storeOnServer: false,
      };
      vault.entries = [entry, ...(Array.isArray(vault.entries) ? vault.entries : [])];
      vault.activeId = id;
      localStorage.setItem("docx-form-web:aiVault:v1", JSON.stringify(vault));
    } catch {
      return { ok: false, error: "บันทึกคีย์ในเครื่องไม่สำเร็จ" };
    }
  }
  writeLocalMode("byok");
  const state = await fetchAiKeySettingsState();
  return {
    ok: true,
    state: {
      ...state,
      mode: "byok",
      userKeySet: true,
      userKeyHint: state.userKeyHint || maskHint(key),
    },
  };
}

export async function deleteUserAiKey(): Promise<
  | { ok: true; state: AiKeySettingsState }
  | { ok: false; error: string }
> {
  try {
    const listRes = await fetch("/api/ai/keys", { credentials: "include" });
    if (listRes.ok) {
      const body = await listRes.json().catch(() => ({ entries: [] }));
      const entries = Array.isArray(body.entries) ? body.entries : [];
      for (const e of entries) {
        const id = String(e?.id || "").trim();
        if (!id) continue;
        await fetch(`/api/ai/keys/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
        });
      }
    }
  } catch {
    /* continue to clear local */
  }
  try {
    localStorage.removeItem("docx-form-web:aiVault:v1");
  } catch {
    /* ignore */
  }
  const state = await fetchAiKeySettingsState();
  return {
    ok: true,
    state: { ...state, userKeySet: false, userKeyHint: undefined },
  };
}

/** Build model picker groups from settings state + model lists (no secrets). */
export function buildAiModelPickerGroups(input: {
  state: AiKeySettingsState;
  serverModels?: { id: string; label: string; source?: string }[];
  byokModels?: { id: string; label: string; source?: string }[];
}): {
  groups: {
    id: "server" | "byok";
    label: string;
    disabled: boolean;
    reason?: string;
    options: { id: string; label: string; source: "server" | "byok" }[];
  }[];
  backendFieldNeed: string;
} {
  const { state } = input;
  const serverModels = (input.serverModels || [])
    .filter((m) => m?.id)
    .map((m) => ({
      id: String(m.id),
      label: String(m.label || m.id),
      source: "server" as const,
    }));
  const byokModels = (input.byokModels || [])
    .filter((m) => m?.id)
    .map((m) => ({
      id: String(m.id),
      label: String(m.label || m.id),
      source: "byok" as const,
    }));

  const serverDisabled =
    state.serverKeyAvailabilityKnown && !state.serverKeyAvailable;
  const byokDisabled = !state.userKeySet;

  return {
    groups: [
      {
        id: "server",
        label: "คีย์กลางของระบบ",
        disabled: serverDisabled,
        reason: serverDisabled
          ? "ระบบยังไม่ได้ตั้งคีย์กลาง"
          : !state.serverKeyAvailabilityKnown
            ? undefined
            : undefined,
        options: serverDisabled ? [] : serverModels,
      },
      {
        id: "byok",
        label: "คีย์ของฉัน",
        disabled: byokDisabled,
        reason: byokDisabled ? "ยังไม่ได้บันทึกคีย์ของฉัน" : undefined,
        options: byokDisabled ? [] : byokModels,
      },
    ],
    backendFieldNeed:
      "models[].source: 'server'|'byok' (or separate serverModels / byokModels on GET /api/ai/status)",
  };
}
