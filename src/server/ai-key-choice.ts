/**
 * AI key choice (system/server vs own/BYOK) — shared gate + status shape.
 * Frontend settings UI owns presentation; this module is the contract source.
 */

import { getAuthPool } from "./auth-db";
import {
  hasServerAiKeyConfigured,
  isByokOnly,
  listConfiguredServerKeySources,
  peekSharedCursorEnvApiKey,
  getGeminiApiKey,
} from "./ai-config";
import {
  ensureUserAiKeysTable,
  listUserAiKeys,
  type UserAiKeyRow,
} from "./ai-key-vault";
import { listAiProviders, getAiProvider } from "./ai-providers";

export type AiKeyMode = "server" | "byok";

/** Non-secret status for settings UI + canUseAi gate (never includes system key). */
export type AiKeyChoiceStatus = {
  mode: AiKeyMode;
  serverKeyAvailable: boolean;
  userKeySet: boolean;
  /** Masked last-4 of the user's own key only — never the system/server key. */
  userKeyHint?: string;
};

/** Model row for the attach-page picker (grouped by source in the FE). */
export type AiModelChoiceOption = {
  id: string;
  label: string;
  provider: string;
  source: AiKeyMode;
};

let prefsSchemaReady: Promise<void> | null = null;

export function resetAiKeyChoiceSchemaGate(): void {
  prefsSchemaReady = null;
}

export async function ensureAiKeyChoiceSchema(): Promise<void> {
  if (!prefsSchemaReady) {
    prefsSchemaReady = (async () => {
      await ensureUserAiKeysTable();
      const pool = getAuthPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_ai_prefs (
          "userId" text PRIMARY KEY,
          mode text NOT NULL DEFAULT 'server',
          "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
          CONSTRAINT user_ai_prefs_mode_chk CHECK (mode IN ('server', 'byok'))
        )
      `);
    })().catch((err) => {
      prefsSchemaReady = null;
      throw err;
    });
  }
  return prefsSchemaReady;
}

/** Pure gate — same rules on client and server. */
export function canUseAi(state: AiKeyChoiceStatus): boolean {
  if (state.mode === "server") return Boolean(state.serverKeyAvailable);
  return Boolean(state.userKeySet);
}

export function normalizeAiKeyMode(raw: unknown): AiKeyMode | null {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (v === "server" || v === "byok") return v;
  return null;
}

/** True when a shared server key may be selected (configured and BYOK-only off). */
export function isServerKeyAvailable(
  envSource: NodeJS.ProcessEnv = process.env,
): boolean {
  // isByokOnly / hasServerAiKeyConfigured read process.env; for tests callers
  // patch env before calling.
  void envSource;
  return hasServerAiKeyConfigured() && !isByokOnly();
}

export function userKeyHintFromRow(row: UserAiKeyRow | null | undefined): string | undefined {
  const key = String(row?.apiKey || "").trim();
  if (!key) return undefined;
  // Frontend contract example: ••••1234 (user key only).
  if (key.length <= 4) return "••••";
  return `••••${key.slice(-4)}`;
}

/**
 * First saved vault key (list order). Used for `userKeyHint` on status —
 * not a “preferred” provider selector for fill (fill matches by model provider).
 */
export function pickPrimaryUserKey(
  rows: UserAiKeyRow[],
): UserAiKeyRow | null {
  if (!rows.length) return null;
  return rows[0] || null;
}

export async function getUserAiKeyMode(userId: string): Promise<AiKeyMode | null> {
  const id = String(userId || "").trim();
  if (!id) return null;
  await ensureAiKeyChoiceSchema();
  const pool = getAuthPool();
  const { rows } = await pool.query<{ mode: string }>(
    `SELECT mode FROM user_ai_prefs WHERE "userId" = $1 LIMIT 1`,
    [id],
  );
  return normalizeAiKeyMode(rows[0]?.mode);
}

export async function setUserAiKeyMode(
  userId: string,
  mode: AiKeyMode,
): Promise<AiKeyMode> {
  const id = String(userId || "").trim();
  if (!id) throw new Error("ต้องเข้าสู่ระบบก่อน");
  const next = normalizeAiKeyMode(mode);
  if (!next) throw new Error("mode ต้องเป็น server หรือ byok");
  if (next === "server" && !isServerKeyAvailable()) {
    const err = new Error(
      "ยังไม่มีคีย์เซิร์ฟเวอร์ให้เลือก — ใช้คีย์ของฉัน หรือให้ผู้ดูแลตั้งคีย์เซิร์ฟเวอร์",
    ) as Error & { code?: string };
    err.code = "AI_SERVER_KEY_UNAVAILABLE";
    throw err;
  }
  await ensureAiKeyChoiceSchema();
  const pool = getAuthPool();
  await pool.query(
    `INSERT INTO user_ai_prefs ("userId", mode, "updatedAt")
     VALUES ($1, $2, NOW())
     ON CONFLICT ("userId") DO UPDATE SET
       mode = EXCLUDED.mode,
       "updatedAt" = NOW()`,
    [id, next],
  );
  return next;
}

/**
 * Build the exact status payload for GET /api/ai/keys/status.
 */
export async function buildAiKeyChoiceStatus(
  userId: string,
): Promise<AiKeyChoiceStatus> {
  const serverKeyAvailable = isServerKeyAvailable();
  const rows = await listUserAiKeys(userId).catch(() => [] as UserAiKeyRow[]);
  const primary = pickPrimaryUserKey(rows);
  const userKeySet = Boolean(primary?.apiKey);
  const userKeyHint = userKeyHintFromRow(primary);

  let mode = (await getUserAiKeyMode(userId)) || null;
  if (!mode) {
    mode = serverKeyAvailable ? "server" : "byok";
  }
  // If stored mode is server but key is gone, surface server with available=false
  // so canUseAi is false until they switch or admin restores the key.
  if (mode === "server" && !serverKeyAvailable && userKeySet) {
    // Keep stored preference; FE can prompt to switch. Gate stays false for server.
  }

  const status: AiKeyChoiceStatus = {
    mode,
    serverKeyAvailable,
    userKeySet,
  };
  if (userKeyHint) status.userKeyHint = userKeyHint;
  return status;
}

/**
 * Resolve which credential path fill routes should take.
 * Optional `source` overrides saved mode for one request.
 */
export function resolveFillCredentialPolicy(
  status: AiKeyChoiceStatus,
  sourceOverride?: AiKeyMode | null,
): "server" | "byok" | "none" {
  const effective: AiKeyChoiceStatus = sourceOverride
    ? { ...status, mode: sourceOverride }
    : status;
  if (!canUseAi(effective)) return "none";
  return effective.mode;
}

/** Unique provider ids the user actually has a vault key for (order preserved). */
export function userProvidersFromKeys(
  rows: Array<Pick<UserAiKeyRow, "provider">>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = String(row?.provider || "").trim();
    if (!id || seen.has(id)) continue;
    if (!getAiProvider(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Models for the attach picker — derived from the live provider catalog.
 * Server models only when serverKeyAvailable (for configured server providers).
 * BYOK models only for providers the user actually has a saved vault key for —
 * never the whole catalog.
 */
export function listAiModelsForChoice(
  status: AiKeyChoiceStatus,
  opts?: { userProviders?: string[] | null },
): AiModelChoiceOption[] {
  const out: AiModelChoiceOption[] = [];
  const seen = new Set<string>();

  const push = (m: AiModelChoiceOption) => {
    const key = `${m.source}:${m.provider}:${m.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  if (status.serverKeyAvailable) {
    const serverProviders = listConfiguredServerKeySources();
    for (const row of serverProviders) {
      const p = getAiProvider(row.providerId);
      if (!p) continue;
      for (const m of p.models || []) {
        const id = String(m.id || "").trim();
        if (!id) continue;
        push({
          id,
          label: String(m.label || id),
          provider: p.id,
          source: "server",
        });
      }
    }
  }

  if (status.userKeySet) {
    const allowed = new Set(
      (opts?.userProviders || [])
        .map((p) => String(p || "").trim())
        .filter(Boolean),
    );
    // No providers → no BYOK models (caller forgot to pass vault providers).
    if (allowed.size > 0) {
      for (const providerId of allowed) {
        const p = getAiProvider(providerId);
        if (!p || p.formAiSupported === false) continue;
        for (const m of p.models || []) {
          const id = String(m.id || "").trim();
          if (!id) continue;
          push({
            id,
            label: String(m.label || id),
            provider: p.id,
            source: "byok",
          });
        }
      }
    }
  }

  return out;
}

/** Load vault rows → provider allow-list for BYOK model listing / gates. */
export async function listUserAiKeyProviders(
  userId: string,
): Promise<string[]> {
  const rows = await listUserAiKeys(userId).catch(() => [] as UserAiKeyRow[]);
  return userProvidersFromKeys(rows);
}

/**
 * Validate that `model` (+ optional provider) is listed for `source`
 * given the user's current key availability.
 * For BYOK, `userProviders` must be the vault-derived allow-list — a model
 * whose provider has no saved key → AI_MODEL_SOURCE_MISMATCH.
 */
export function validateModelForSource(input: {
  status: AiKeyChoiceStatus;
  source: AiKeyMode;
  model?: string | null;
  provider?: string | null;
  /** Vault providers for BYOK; required for accurate mismatch checks. */
  userProviders?: string[] | null;
}):
  | { ok: true; source: AiKeyMode; model: string; provider: string }
  | { ok: false; status: 400; error: string; code: string } {
  const source = input.source;
  const gateStatus: AiKeyChoiceStatus = { ...input.status, mode: source };
  if (!canUseAi(gateStatus)) {
    if (source === "server") {
      return {
        ok: false,
        status: 400,
        code: "AI_SERVER_KEY_UNAVAILABLE",
        error: "ยังไม่มีคีย์เซิร์ฟเวอร์ — เลือกคีย์ของฉันหรือให้ผู้ดูแลตั้งคีย์เซิร์ฟเวอร์",
      };
    }
    return {
      ok: false,
      status: 400,
      code: "AI_KEY_REQUIRED",
      error: "ยังไม่มีคีย์ของฉัน — บันทึกคีย์ก่อน หรือเลือกคีย์เซิร์ฟเวอร์",
    };
  }

  const listOpts = { userProviders: input.userProviders || [] };
  const model = String(input.model || "").trim();
  if (!model) {
    // Model optional at gate time — fill routes may apply provider default.
    const models = listAiModelsForChoice(gateStatus, listOpts).filter(
      (m) => m.source === source,
    );
    const preferredProvider = String(input.provider || "").trim();
    const hit =
      models.find((m) => m.provider === preferredProvider) || models[0];
    if (!hit) {
      return {
        ok: false,
        status: 400,
        code: "AI_MODEL_UNAVAILABLE",
        error: "ไม่มีโมเดลสำหรับแหล่งคีย์นี้",
      };
    }
    return {
      ok: true,
      source,
      model: hit.id,
      provider: hit.provider,
    };
  }

  const models = listAiModelsForChoice(gateStatus, listOpts).filter(
    (m) => m.source === source,
  );
  const providerWant = String(input.provider || "").trim();
  const hit = models.find(
    (m) =>
      m.id === model && (!providerWant || m.provider === providerWant),
  );
  if (!hit) {
    return {
      ok: false,
      status: 400,
      code: "AI_MODEL_SOURCE_MISMATCH",
      error:
        source === "server"
          ? "โมเดลนี้ไม่ใช่ของคีย์เซิร์ฟเวอร์ — เลือกโมเดลในกลุ่มคีย์เซิร์ฟเวอร์"
          : "โมเดลนี้ไม่ใช่ของคีย์ของฉัน — เลือกโมเดลของผู้ให้บริการที่คุณมีคีย์บันทึกไว้",
    };
  }
  return { ok: true, source, model: hit.id, provider: hit.provider };
}

/** Resolve shared server api key for fill (never log). */
export function resolveServerFillApiKey(providerId: string): string | undefined {
  const p = getAiProvider(providerId);
  if (!p) return undefined;
  if (p.apiFamily === "cursor") return peekSharedCursorEnvApiKey();
  if (p.apiFamily === "gemini") return getGeminiApiKey(undefined);
  return undefined;
}

/** Hint formatter used in tests. */
export function formatUserKeyHint(apiKey: string): string | undefined {
  return userKeyHintFromRow({
    id: "x",
    provider: "google",
    label: "",
    model: "",
    apiKey,
  });
}
