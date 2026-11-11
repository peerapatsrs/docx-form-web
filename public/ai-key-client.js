/**
 * Typed client for /api/ai/keys (session cookie auth).
 * Contract: docs/FE-AI-KEY-CONTRACT.md + Backend docs/API-AI-KEYS-AND-SKIP.md
 * — never log or return plaintext secrets from GET; after save drop local plaintext.
 */

/** Backend ships POST /api/ai/keys/:id/test (+ plaintext test, rotate via PUT /:id, audit). */
export const AI_KEY_TEST_ENABLED = true;

/** @typedef {{ id: string, provider: string, label: string, model: string, maskedKey?: string, hasKey?: boolean, storeOnServer?: boolean, lastUsedAt?: string|null, lastTestAt?: string|null, lastTestOk?: boolean|null, lastTestCode?: string|null, lastTestMessage?: string|null, lastTestStatus?: string|null }} AiKeyMaskedEntry */
/** @typedef {{ id?: string, provider: string, label?: string, model?: string, apiKey: string }} AiKeyWriteEntry */
/** @typedef {{ ok: true, entries: AiKeyMaskedEntry[] }} AiKeyWriteResult */
/** @typedef {{ ok: true, removed: true, code?: string }} AiKeyDeleteResult */
/** @typedef {{ error: string, code?: string, status: number }} AiKeyClientError */
/** @typedef {{ th: string, en: string }} LocaleCopy */

/** @type {Record<string, LocaleCopy>} */
const AI_CODE_MESSAGES = {
  AI_KEY_UNAUTHORIZED: {
    th: "ต้องเข้าสู่ระบบก่อนจึงจะจัดการคีย์บนเซิร์ฟเวอร์ได้",
    en: "Sign in to manage server-stored AI keys.",
  },
  AI_KEY_NOT_FOUND: {
    th: "ไม่พบคีย์นี้ — อาจถูกลบไปแล้ว",
    en: "That AI key was not found — it may have been deleted.",
  },
  AI_KEY_INVALID_ID: {
    th: "รหัสคีย์ไม่ถูกต้อง",
    en: "Invalid AI key id.",
  },
  AI_KEY_INVALID_PROVIDER: {
    th: "ผู้ให้บริการนี้ยังไม่รองรับ — เลือกเจ้าอื่นแล้วลองใหม่",
    en: "Unknown or unsupported AI provider.",
  },
  AI_KEY_INVALID_VALUE: {
    th: "คีย์สั้นเกินไปหรือว่าง — วางคีย์ให้ครบแล้วลองใหม่",
    en: "API key is missing or too short.",
  },
  AI_KEY_MISSING: {
    th: "ยังไม่ได้ใส่คีย์ API",
    en: "API key is required.",
  },
  AI_KEY_INVALID: {
    th: "คีย์นี้ใช้ไม่ได้ — ตรวจว่าคัดลอกครบ และเป็นคีย์ของผู้ให้บริการที่เลือก จากนั้นลองอีกครั้ง",
    en: "This API key was rejected — check that it is complete and for the selected provider.",
  },
  AI_SERVER_KEY_INVALID: {
    th: "คีย์เซิร์ฟเวอร์ถูกผู้ให้บริการปฏิเสธ — ไม่ใช่คีย์ส่วนตัวของคุณ แจ้งผู้ดูแลระบบให้ตรวจคีย์เซิร์ฟเวอร์",
    en: "The server shared AI key was rejected by the provider — not your personal key. Ask an admin to check the server key.",
  },
  AI_AUTH: {
    th: "คีย์ AI หรือสิทธิ์ไม่ถูกต้อง",
    en: "AI API key or permission was rejected.",
  },
  AI_KEY_MISSING_FIELDS: {
    th: "ข้อมูลคีย์ไม่ครบ — ตรวจผู้ให้บริการและคีย์แล้วลองใหม่",
    en: "Key request body is incomplete.",
  },
  AI_KEY_EXISTS: {
    th: "มีคีย์รหัสนี้อยู่แล้ว — ใช้เปลี่ยนคีย์แทนการสร้างใหม่",
    en: "An AI key with this id already exists.",
  },
  AI_KEY_PROVIDER_AUTH: {
    th: "คีย์นี้ใช้ไม่ได้ — ผู้ให้บริการปฏิเสธการยืนยันตัวตน",
    en: "Provider rejected this API key (auth).",
  },
  AI_KEY_PROVIDER_ERROR: {
    th: "ผู้ให้บริการตอบกลับผิดพลาดขณะตรวจคีย์ — ลองใหม่ภายหลัง",
    en: "Provider error while checking the API key.",
  },
  AI_KEY_TEST_TIMEOUT: {
    th: "หมดเวลารอตอนทดสอบคีย์ — ลองใหม่หรือเปลี่ยนโมเดล/เครือข่าย",
    en: "Timed out while testing the API key.",
  },
  AI_KEY_SERVER_ERROR: {
    th: "เซิร์ฟเวอร์มีปัญหาขณะจัดการคีย์ — ลองใหม่ภายหลัง",
    en: "Server error while managing AI keys.",
  },
  AI_KEY_CREATED: {
    th: "สร้างคีย์แล้ว",
    en: "AI key created.",
  },
  AI_KEY_REPLACED: {
    th: "เปลี่ยนคีย์แล้ว",
    en: "AI key replaced.",
  },
  AI_KEY_DELETED: {
    th: "ลบคีย์แล้ว",
    en: "AI key deleted.",
  },
  AI_KEY_USED: {
    th: "ใช้คีย์นี้กับคำขอ AI แล้ว",
    en: "AI key was used.",
  },
  AI_KEY_TEST_OK: {
    th: "คีย์ใช้งานได้",
    en: "API key works.",
  },
  AI_PROVIDER_AUTH: {
    th: "คีย์หรือสิทธิ์ไม่ผ่านกับผู้ให้บริการ",
    en: "Provider authentication failed.",
  },
  AI_PROVIDER_RATE_LIMIT: {
    th: "ผู้ให้บริการจำกัดอัตราการเรียก — รอสักครู่แล้วลองใหม่",
    en: "Provider rate limit — wait and try again.",
  },
  AI_PROVIDER_QUOTA: {
    th: "เครดิต/โควตาของผู้ให้บริการหมดแล้ว",
    en: "Provider credits or quota exhausted.",
  },
  AI_PROVIDER_TIMEOUT: {
    th: "หมดเวลารอผู้ให้บริการ — ลองใหม่ภายหลัง",
    en: "Provider request timed out.",
  },
  AI_PROVIDER_UNAVAILABLE: {
    th: "ผู้ให้บริการล่มหรือไม่พร้อม — ลองใหม่ภายหลัง",
    en: "Provider unavailable.",
  },
  AI_PROVIDER_BAD_REQUEST: {
    th: "คำขอไปยังผู้ให้บริการไม่ถูกต้อง (เช่น โมเดล)",
    en: "Bad request to the provider (e.g. model).",
  },
  AI_PROVIDER_ERROR: {
    th: "ผู้ให้บริการตอบกลับผิดพลาด — ลองใหม่ภายหลัง",
    en: "Provider error.",
  },
};

/** @type {Record<string, LocaleCopy>} */
const FILL_CODE_MESSAGES = {
  FILL_MISSING_FILE: {
    th: "ยังไม่มีไฟล์เทมเพลต — อัปโหลด .docx ก่อน",
    en: "Template file is missing.",
  },
  FILL_INVALID_FILE: {
    th: "ไฟล์เทมเพลตใช้ไม่ได้ — เลือกไฟล์ .docx ที่ถูกต้อง",
    en: "Template file is not a usable .docx.",
  },
  FILL_MISSING_VALUES: {
    th: "ไม่มีค่าที่จะใส่ในเอกสาร",
    en: "Fill values are missing.",
  },
  FILL_BAD_JSON: {
    th: "รูปแบบค่า (JSON) ไม่ถูกต้อง",
    en: "Values payload is not valid JSON.",
  },
  FILL_BAD_SKIP: {
    th: "ข้อมูล「ข้าม」ไม่ถูกต้อง",
    en: "Skip map is not a JSON object.",
  },
  FILL_BAD_ROW_SKIP: {
    th: "ข้อมูล「ข้าม」ในแถวไม่ถูกต้อง",
    en: "Row-skip map is not a JSON object.",
  },
  FILL_LIST_NOT_ARRAY: {
    th: "ค่ารายการต้องเป็นแถวในตาราง",
    en: "List field value must be an array.",
  },
  FILL_IMAGE_TOO_LARGE: {
    th: "รูปใหญ่เกิน 8 MB",
    en: "Image exceeds 8 MB.",
  },
  FILL_IMAGE_INVALID: {
    th: "ไฟล์รูปใช้ไม่ได้",
    en: "Upload is not a valid image.",
  },
};

/**
 * App UI is Thai-first. Pass `locale: "en"` explicitly for English copy.
 * @param {string} [locale]
 * @returns {"th"|"en"}
 */
function resolveLocale(locale) {
  const raw = String(locale || "").trim().toLowerCase();
  if (raw.startsWith("en")) return "en";
  return "th";
}

/**
 * @param {LocaleCopy | undefined} copy
 * @param {"th"|"en"} lang
 */
function pickCopy(copy, lang) {
  if (!copy) return "";
  return (lang === "en" ? copy.en : copy.th) || copy.th || copy.en || "";
}

/**
 * Map API error payload to UI copy. Prefers stable `code`, then `error` text,
 * then a generic message. Default locale is Thai (app UI).
 * @param {{ error?: string, code?: string, message?: string } | null | undefined} data
 * @param {number} [status]
 * @param {string} [locale]
 */
export function mapAiKeyError(data, status = 0, locale) {
  const lang = resolveLocale(locale);
  const code = String(data?.code || "").trim();
  const fallback = String(data?.error || data?.message || "").trim();
  if (code && AI_CODE_MESSAGES[code]) {
    // Success-ish codes should still resolve if misrouted here.
    return pickCopy(AI_CODE_MESSAGES[code], lang);
  }
  if (/api key not valid|invalid api key|invalid user api key|incorrect api key/i.test(fallback)) {
    return pickCopy(AI_CODE_MESSAGES.AI_KEY_INVALID, lang);
  }
  if (/permission|forbidden|unauthorized/i.test(fallback) && status === 401) {
    return pickCopy(AI_CODE_MESSAGES.AI_KEY_UNAUTHORIZED, lang);
  }
  if (fallback && !/^[A-Za-z0-9_ ."'-]+$/.test(fallback)) {
    return fallback;
  }
  if (fallback && /[A-Za-z]{4,}/.test(fallback)) {
    const base = pickCopy(AI_CODE_MESSAGES.AI_KEY_INVALID, lang);
    return `${base} (${fallback.slice(0, 80)})`;
  }
  if (fallback) return fallback;
  if (status === 401) return pickCopy(AI_CODE_MESSAGES.AI_KEY_UNAUTHORIZED, lang);
  if (status === 404) return pickCopy(AI_CODE_MESSAGES.AI_KEY_NOT_FOUND, lang);
  if (status === 504) return pickCopy(AI_CODE_MESSAGES.AI_PROVIDER_TIMEOUT, lang);
  if (status === 429) return pickCopy(AI_CODE_MESSAGES.AI_PROVIDER_RATE_LIMIT, lang);
  if (status >= 500) return pickCopy(AI_CODE_MESSAGES.AI_KEY_SERVER_ERROR, lang);
  if (status === 400) {
    return lang === "en"
      ? "Invalid request — check the details and try again."
      : "คำขอไม่ถูกต้อง — ตรวจข้อมูลแล้วลองใหม่";
  }
  return lang === "en"
    ? "Could not complete the AI key request."
    : "ดำเนินการกับคีย์ AI ไม่สำเร็จ";
}

/**
 * Success / info codes → toast copy (AI_KEY_CREATED, TEST_OK, …).
 * @param {{ code?: string, message?: string, error?: string } | null | undefined} data
 * @param {string} [locale]
 */
export function mapAiKeySuccess(data, locale) {
  const lang = resolveLocale(locale);
  const code = String(data?.code || "").trim();
  if (code && AI_CODE_MESSAGES[code]) return pickCopy(AI_CODE_MESSAGES[code], lang);
  const msg = String(data?.message || data?.error || "").trim();
  if (msg) return msg;
  return lang === "en" ? "Done." : "สำเร็จ";
}

/**
 * Map fill / generate error `{ error, code }` to UI copy.
 * @param {{ error?: string, code?: string } | null | undefined} data
 * @param {number} [status]
 * @param {string} [locale]
 * @param {string} [generic]
 */
export function mapFillError(data, status = 0, locale, generic) {
  const lang = resolveLocale(locale);
  const code = String(data?.code || "").trim();
  const fallback = String(data?.error || "").trim();
  if (code && FILL_CODE_MESSAGES[code]) return pickCopy(FILL_CODE_MESSAGES[code], lang);
  // Provider / AI codes can surface on generate when BYOK fails mid-fill.
  if (code && AI_CODE_MESSAGES[code]) return pickCopy(AI_CODE_MESSAGES[code], lang);
  if (
    /คีย์เซิร์ฟเวอร์|server shared ai key|AI_SERVER_KEY_INVALID/i.test(fallback) ||
    (/invalid user api key/i.test(fallback) && /เซิร์ฟเวอร์|server/i.test(fallback))
  ) {
    return pickCopy(AI_CODE_MESSAGES.AI_SERVER_KEY_INVALID, lang) || fallback;
  }
  if (fallback) return fallback;
  if (generic) return generic;
  return lang === "en" ? "Could not generate the document." : "สร้างเอกสารไม่สำเร็จ";
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
    maskedKey:
      String(raw.maskedKey || raw.hint || "").trim() || (raw.hasKey ? "••••" : ""),
    hasKey: raw.hasKey !== false,
    storeOnServer: raw.storeOnServer !== false,
    lastUsedAt: raw.lastUsedAt ? String(raw.lastUsedAt) : null,
    lastTestAt: raw.lastTestAt ? String(raw.lastTestAt) : null,
    lastTestOk: typeof raw.lastTestOk === "boolean" ? raw.lastTestOk : null,
    lastTestCode: raw.lastTestCode ? String(raw.lastTestCode) : null,
    lastTestMessage: raw.lastTestMessage ? String(raw.lastTestMessage) : null,
    lastTestStatus: raw.lastTestStatus ? String(raw.lastTestStatus) : null,
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
 * @returns {Promise<{ ok: true, entries: AiKeyMaskedEntry[], code?: string } | { ok: false, error: AiKeyClientError }>}
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
      error: {
        error: mapAiKeyError({ code: "AI_KEY_MISSING_FIELDS" }, 400),
        code: "AI_KEY_MISSING_FIELDS",
        status: 400,
      },
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
      : data?.entry
        ? [normalizeMaskedEntry(data.entry)].filter(Boolean)
        : [];
    return { ok: true, entries, code: data?.code };
  } catch {
    return {
      ok: false,
      error: { error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", status: 0 },
    };
  }
}

/**
 * PUT /api/ai/keys/:id — replace / rotate value (live-validated).
 * @param {string} id
 * @param {{ apiKey: string, label?: string, model?: string, provider?: string }} body
 * @returns {Promise<{ ok: true, entry: AiKeyMaskedEntry, code?: string } | { ok: false, error: AiKeyClientError }>}
 */
export async function replaceAiKey(id, body) {
  const keyId = String(id || "").trim();
  if (!keyId) {
    return {
      ok: false,
      error: {
        error: mapAiKeyError({ code: "AI_KEY_INVALID_ID" }, 400),
        code: "AI_KEY_INVALID_ID",
        status: 400,
      },
    };
  }
  try {
    const { res, data } = await fetchJson(
      `/api/ai/keys/${encodeURIComponent(keyId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      },
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
    const entry = normalizeMaskedEntry(data?.entry);
    if (!entry) {
      return {
        ok: false,
        error: {
          error: mapAiKeyError({ code: "AI_KEY_SERVER_ERROR" }, 500),
          code: "AI_KEY_SERVER_ERROR",
          status: 500,
        },
      };
    }
    return {
      ok: true,
      entry,
      code: data?.code || "AI_KEY_REPLACED",
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
 * @returns {Promise<{ ok: true, removed: true, code?: string } | { ok: false, error: AiKeyClientError }>}
 */
export async function deleteAiKey(id) {
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
    return {
      ok: true,
      removed: true,
      code: data?.code || "AI_KEY_DELETED",
    };
  } catch {
    return {
      ok: false,
      error: { error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", status: 0 },
    };
  }
}

/**
 * POST /api/ai/keys/:id/test — probe a saved vault key.
 * @param {string} id
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, code: string, message: string, entry?: AiKeyMaskedEntry|null, durationMs?: number } | { ok: false, error: AiKeyClientError }>}
 */
export async function testAiKey(id, opts = {}) {
  const keyId = String(id || "").trim();
  if (!keyId) {
    return {
      ok: false,
      error: {
        error: mapAiKeyError({ code: "AI_KEY_INVALID_ID" }, 400),
        code: "AI_KEY_INVALID_ID",
        status: 400,
      },
    };
  }
  try {
    const body =
      typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {};
    const { res, data } = await fetchJson(
      `/api/ai/keys/${encodeURIComponent(keyId)}/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok || data?.ok === false) {
      return {
        ok: false,
        error: {
          error: mapAiKeyError(data, res.status),
          code: data?.code,
          status: res.status,
        },
      };
    }
    return {
      ok: true,
      code: String(data?.code || "AI_KEY_TEST_OK"),
      message: mapAiKeySuccess(data),
      entry: data?.entry ? normalizeMaskedEntry(data.entry) : null,
      durationMs: Number(data?.durationMs) || undefined,
    };
  } catch {
    return {
      ok: false,
      error: { error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", status: 0 },
    };
  }
}

/**
 * POST /api/ai/keys/test — probe plaintext before save (does not persist).
 * @param {{ provider: string, apiKey: string, timeoutMs?: number }} body
 */
export async function testAiKeyPlaintext(body) {
  const provider = String(body?.provider || "").trim();
  const apiKey = String(body?.apiKey || "").trim();
  if (!provider || !apiKey) {
    return {
      ok: false,
      error: {
        error: mapAiKeyError({ code: "AI_KEY_MISSING_FIELDS" }, 400),
        code: "AI_KEY_MISSING_FIELDS",
        status: 400,
      },
    };
  }
  try {
    const { res, data } = await fetchJson("/api/ai/keys/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        apiKey,
        ...(typeof body.timeoutMs === "number"
          ? { timeoutMs: body.timeoutMs }
          : {}),
      }),
    });
    if (!res.ok || data?.ok === false) {
      return {
        ok: false,
        error: {
          error: mapAiKeyError(data, res.status),
          code: data?.code,
          status: res.status,
        },
      };
    }
    return {
      ok: true,
      code: String(data?.code || "AI_KEY_TEST_OK"),
      message: mapAiKeySuccess(data),
      durationMs: Number(data?.durationMs) || undefined,
    };
  } catch {
    return {
      ok: false,
      error: { error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", status: 0 },
    };
  }
}

/**
 * GET /api/ai/keys/audit
 * @param {{ keyId?: string, limit?: number }} [opts]
 */
export async function listAiKeyAudit(opts = {}) {
  const params = new URLSearchParams();
  if (opts.keyId) params.set("keyId", String(opts.keyId));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  try {
    const { res, data } = await fetchJson(
      `/api/ai/keys/audit${qs ? `?${qs}` : ""}`,
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
    const events = Array.isArray(data?.events) ? data.events : [];
    return { ok: true, events };
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
