/**
 * Typed client for /api/ai/keys (session cookie auth).
 * Contract: docs/FE-AI-KEY-CONTRACT.md — never log or return plaintext secrets
 * from GET; after PUT the caller should drop local plaintext.
 */

/** Backend ships POST /api/ai/keys/:id/test (+ rotate/audit) — enable test UI. */
export const AI_KEY_TEST_ENABLED = true;

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
    AI_KEY_INVALID_VALUE: "กรุณาใส่ API key ที่ถูกต้อง",
    AI_KEY_INVALID_PROVIDER: "ผู้ให้บริการนี้ยังไม่รองรับ",
    AI_KEY_INVALID_ID: "รหัสคีย์ไม่ถูกต้อง",
    AI_KEY_MISSING: "ยังไม่ได้ใส่คีย์ API",
    AI_KEY_MISSING_FIELDS: "ข้อมูลคีย์ไม่ครบ",
    AI_KEY_EXISTS: "มีคีย์รหัสนี้อยู่แล้ว",
    AI_KEY_UNAUTHORIZED: "ต้องเข้าสู่ระบบก่อนจึงจะบันทึกคีย์บนเซิร์ฟเวอร์ได้",
    AI_KEY_NOT_FOUND: "ไม่พบคีย์นี้ — อาจถูกลบไปแล้ว",
    AI_KEY_PROVIDER_AUTH:
      "คีย์นี้ใช้ไม่ได้ — ตรวจว่าคัดลอกครบ และเป็นคีย์ของผู้ให้บริการที่เลือก จากนั้นลองอีกครั้ง",
    AI_KEY_PROVIDER_ERROR: "ผู้ให้บริการตอบไม่สำเร็จ — ลองใหม่ภายหลัง",
    AI_KEY_TEST_TIMEOUT: "หมดเวลารอผู้ให้บริการ — ลองใหม่ภายหลัง",
    AI_KEY_TEST_OK: "คีย์ใช้งานได้",
    AI_PROVIDER_AUTH:
      "คีย์นี้ใช้ไม่ได้ — ตรวจว่าคัดลอกครบ และเป็นคีย์ของผู้ให้บริการที่เลือก จากนั้นลองอีกครั้ง",
    AI_PROVIDER_RATE_LIMIT: "เรียกถี่เกินไป — รอสักครู่แล้วลองใหม่",
    AI_PROVIDER_QUOTA: "เครดิต/โควต้าของผู้ให้บริการหมด — เติมที่คอนโซลหรือเปลี่ยนคีย์",
    AI_PROVIDER_TIMEOUT: "หมดเวลารอผู้ให้บริการ — ลองใหม่ภายหลัง",
    AI_PROVIDER_UNAVAILABLE: "ผู้ให้บริการมีปัญหาชั่วคราว — ลองใหม่ภายหลัง",
    AI_PROVIDER_BAD_REQUEST: "คำขอไม่ถูกต้อง — ตรวจโมเดลหรือคีย์แล้วลองใหม่",
    AI_PROVIDER_ERROR: "ผู้ให้บริการตอบไม่สำเร็จ — ลองใหม่ภายหลัง",
    AI_KEY_SERVER_ERROR: "เซิร์ฟเวอร์มีปัญหา — ลองใหม่ภายหลัง",
  };
  if (code && byCode[code]) return byCode[code];
  // Map common English provider errors to Thai (F27/F28) — keep dialog open via caller.
  if (/api key not valid|invalid api key|invalid user api key|incorrect api key/i.test(fallback)) {
    return byCode.AI_KEY_INVALID;
  }
  if (/permission|forbidden|unauthorized/i.test(fallback) && status === 401) {
    return byCode.AI_KEY_UNAUTHORIZED;
  }
  if (fallback && !/^[A-Za-z0-9_ ."'-]+$/.test(fallback)) {
    // Already Thai (or mixed) — show as-is.
    return fallback;
  }
  if (fallback && /[A-Za-z]{4,}/.test(fallback)) {
    return `${byCode.AI_KEY_INVALID} (${fallback.slice(0, 80)})`;
  }
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
 * POST /api/ai/keys/:id/test — probe a saved vault key (F30 / FE flag).
 * @param {string} id
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, code: string, message: string, provider?: string, durationMs?: number, entry?: AiKeyMaskedEntry | null } | { ok: false, error: AiKeyClientError }>}
 */
export async function testAiKey(id, opts = {}) {
  const keyId = String(id || "").trim();
  if (!keyId) {
    return {
      ok: false,
      error: {
        error: mapAiKeyError({ code: "AI_KEY_NOT_FOUND" }, 400),
        code: "AI_KEY_NOT_FOUND",
        status: 400,
      },
    };
  }
  try {
    const { res, data } = await fetchJson(
      `/api/ai/keys/${encodeURIComponent(keyId)}/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeoutMs:
            typeof opts.timeoutMs === "number" ? opts.timeoutMs : undefined,
        }),
      },
    );
    if (!res.ok) {
      return {
        ok: false,
        error: {
          error: mapAiKeyError(
            { error: data?.error || data?.message, code: data?.code },
            res.status,
          ),
          code: data?.code,
          status: res.status,
        },
      };
    }
    return {
      ok: true,
      code: String(data?.code || "AI_KEY_TEST_OK"),
      message: String(data?.message || "คีย์ใช้งานได้"),
      provider: data?.provider,
      durationMs: data?.durationMs,
      entry: data?.entry ? normalizeMaskedEntry(data.entry) : null,
    };
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
