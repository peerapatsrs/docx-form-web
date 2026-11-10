/**
 * Typed client for /api/ai/keys (session cookie auth).
 * Contract: docs/FE-AI-KEY-CONTRACT.md — never log or return plaintext secrets
 * from GET; after PUT the caller should drop local plaintext.
 */

/** Flip to true when Backend ships POST /api/ai/keys/:id/test (and rotate/audit). */
export const AI_KEY_TEST_ENABLED = false;

/** @typedef {{ id: string, provider: string, label: string, model: string, maskedKey?: string, hasKey?: boolean, storeOnServer?: boolean }} AiKeyMaskedEntry */
/** @typedef {{ id?: string, provider: string, label?: string, model?: string, apiKey: string }} AiKeyWriteEntry */
/** @typedef {{ ok: true, entries: AiKeyMaskedEntry[] }} AiKeyWriteResult */
/** @typedef {{ ok: true, removed: true }} AiKeyDeleteResult */
/** @typedef {{ error: string, code?: string, status: number }} AiKeyClientError */

/**
 * Map API error payload to Thai UI copy. Prefers stable `code` when present;
 * otherwise uses the Thai `error` string from Backend.
 * @param {{ error?: string, code?: string } | null | undefined} data
 * @param {number} [status]
 */
export function mapAiKeyError(data, status = 0) {
  const code = String(data?.code || "").trim();
  const fallback = String(data?.error || "").trim();
  /** @type {Record<string, string>} */
  const byCode = {
    AI_KEY_INVALID:
      "คีย์นี้ใช้ไม่ได้ — ตรวจว่าคัดลอกครบ และเป็นคีย์ของผู้ให้บริการที่เลือก จากนั้นลองอีกครั้ง",
    AI_KEY_MISSING: "ยังไม่ได้ใส่คีย์ API",
    AI_KEY_UNAUTHORIZED: "ต้องเข้าสู่ระบบก่อนจึงจะบันทึกคีย์บนเซิร์ฟเวอร์ได้",
    AI_KEY_NOT_FOUND: "ไม่พบคีย์นี้ — อาจถูกลบไปแล้ว",
  };
  if (code && byCode[code]) return byCode[code];
  if (fallback) return fallback;
  if (status === 401) return "ต้องเข้าสู่ระบบก่อนจึงจะจัดการคีย์บนเซิร์ฟเวอร์ได้";
  if (status === 404) return "ไม่พบคีย์นี้ — อาจถูกลบไปแล้ว";
  if (status === 400) return "คำขอไม่ถูกต้อง — ตรวจข้อมูลแล้วลองใหม่";
  return "ดำเนินการกับคีย์ AI ไม่สำเร็จ";
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ res: Response, data: any }>}
 */
async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * @param {any} raw
 * @returns {AiKeyMaskedEntry | null}
 */
export function normalizeMaskedEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    provider: String(raw.provider || "google").trim() || "google",
    label: String(raw.label || "").trim(),
    model: String(raw.model || "").trim(),
    maskedKey: String(raw.maskedKey || "").trim() || (raw.hasKey ? "••••" : ""),
    hasKey: raw.hasKey !== false,
    storeOnServer: raw.storeOnServer !== false,
  };
}

/**
 * GET /api/ai/keys
 * @returns {Promise<{ ok: true, entries: AiKeyMaskedEntry[] } | { ok: false, error: AiKeyClientError }>}
 */
export async function listAiKeys() {
  try {
    const { res, data } = await fetchJson("/api/ai/keys");
    if (!res.ok) {
      return {
        ok: false,
        error: {
          error: mapAiKeyError(data, res.status),
          code: data?.code,
          status: res.status,
        },
      };
    }
    const entries = Array.isArray(data?.entries)
      ? data.entries.map(normalizeMaskedEntry).filter(Boolean)
      : [];
    return { ok: true, entries };
  } catch {
    return {
      ok: false,
      error: { error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", status: 0 },
    };
  }
}

/**
 * PUT /api/ai/keys — upsert one entry (or pass `entries` for batch).
 * @param {AiKeyWriteEntry | { entry?: AiKeyWriteEntry, entries?: AiKeyWriteEntry[] }} body
 * @returns {Promise<{ ok: true, entries: AiKeyMaskedEntry[] } | { ok: false, error: AiKeyClientError }>}
 */
export async function upsertAiKeys(body) {
  /** @type {{ entry?: AiKeyWriteEntry, entries?: AiKeyWriteEntry[] }} */
  let payload;
  if (body && typeof body === "object" && ("entry" in body || "entries" in body)) {
    payload = /** @type {any} */ (body);
  } else {
    payload = { entry: /** @type {AiKeyWriteEntry} */ (body) };
  }
  if (!payload.entry && !(Array.isArray(payload.entries) && payload.entries.length)) {
    return {
      ok: false,
      error: { error: mapAiKeyError({ code: "AI_KEY_MISSING" }, 400), code: "AI_KEY_MISSING", status: 400 },
    };
  }
  try {
    const { res, data } = await fetchJson("/api/ai/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: {
          error: mapAiKeyError(data, res.status),
          code: data?.code,
          status: res.status,
        },
      };
    }
    const entries = Array.isArray(data?.entries)
      ? data.entries.map(normalizeMaskedEntry).filter(Boolean)
      : [];
    return { ok: true, entries };
  } catch {
    return {
      ok: false,
      error: { error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", status: 0 },
    };
  }
}

/**
 * DELETE /api/ai/keys/:id
 * @param {string} id
 * @returns {Promise<{ ok: true, removed: true } | { ok: false, error: AiKeyClientError }>}
 */
export async function deleteAiKey(id) {
  const keyId = String(id || "").trim();
  if (!keyId) {
    return {
      ok: false,
      error: { error: mapAiKeyError({ code: "AI_KEY_NOT_FOUND" }, 400), code: "AI_KEY_NOT_FOUND", status: 400 },
    };
  }
  try {
    const { res, data } = await fetchJson(
      `/api/ai/keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      return {
        ok: false,
        error: {
          error: mapAiKeyError(data, res.status),
          code: data?.code,
          status: res.status,
        },
      };
    }
    return { ok: true, removed: true };
  } catch {
    return {
      ok: false,
      error: { error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", status: 0 },
    };
  }
}

/**
 * Headers for AI feature calls. Prefer vault id only — never attach raw key
 * when `storeOnServer` + logged-in. Guest local keys may still send the key.
 * @param {{ id?: string, apiKey?: string, model?: string, provider?: string, storeOnServer?: boolean } | null | undefined} entry
 * @param {{ loggedIn?: boolean }} [opts]
 * @param {Record<string, string>} [extra]
 */
export function aiKeyAuthHeaders(entry, opts = {}, extra = {}) {
  /** @type {Record<string, string>} */
  const h = { ...extra };
  if (!entry) return h;
  const id = String(entry.id || "").trim();
  const key = String(entry.apiKey || "").trim();
  const model = String(entry.model || "").trim();
  const provider = String(entry.provider || "google").trim();
  const useVaultId = !!(entry.storeOnServer && id && opts.loggedIn);
  if (useVaultId) {
    h["X-Ai-Key-Id"] = id;
  } else if (key) {
    // Local-only BYOK (guest) — Backend may still accept legacy headers.
    h["X-Ai-Api-Key"] = key;
    h["X-Gemini-Api-Key"] = key;
  }
  if (model) {
    h["X-Ai-Model"] = model;
    h["X-Gemini-Model"] = model;
  }
  if (provider) h["X-Ai-Provider"] = provider;
  return h;
}

/**
 * Mask a key for local display before the server returns maskedKey.
 * Never log the input.
 * @param {string} key
 */
export function maskAiKeyLocal(key) {
  const k = String(key || "").trim();
  if (!k) return "••••";
  if (k.length <= 4) return "••••";
  return `sk-…${k.slice(-4)}`;
}
