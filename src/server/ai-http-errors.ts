/**
 * Short Thai-friendly AI provider HTTP errors for UI banners.
 * Never dump raw JSON (e.g. DeepSeek 402 Insufficient Balance).
 */

const UI_MSG_MAX = 90;

type ProviderErrorBody = {
  error?: string | { message?: string; code?: string | number; type?: string };
  message?: string;
  code?: string | number;
};

/** Pull a human message out of common OpenAI / Anthropic / DeepSeek / Google bodies. */
export function extractProviderErrorMessage(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as ProviderErrorBody;
    if (typeof parsed.error === "string") return parsed.error.trim();
    if (parsed.error && typeof parsed.error === "object") {
      const m = parsed.error.message || parsed.error.code || parsed.error.type;
      if (m != null && String(m).trim()) return String(m).trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    /* plain text */
  }
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeDetail(raw: string, max = UI_MSG_MAX): string {
  let text = extractProviderErrorMessage(raw);
  if (!text) return "";
  text = text.replace(/\s+/g, " ").replace(/[{}\[\]]/g, "").trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

function looksInsufficientBalance(hay: string): boolean {
  return /insufficient[_\s-]?balance|insufficient[_\s-]?credits|out of credits|no credits|credit balance|payment required|billing not active|余额不足|餘額不足/i.test(
    hay,
  );
}

function looksInvalidKey(hay: string): boolean {
  return /invalid.?api.?key|incorrect api key|api key not valid|unauthorized|authentication|permission.?denied|invalid.?key|wrong api key|expired.?key/i.test(
    hay,
  );
}

function looksQuota(hay: string): boolean {
  return /quota|exceeded your current quota|free_tier|billing|generaterequestsperday|generate_requests|resource_exhausted|usage.?limit/i.test(
    hay,
  );
}

function looksRateLimit(hay: string): boolean {
  return /rate.?limit|too many requests|throttle|requests per (minute|second)|\brpm\b|\btpm\b/i.test(
    hay,
  );
}

function looksModelMissing(hay: string): boolean {
  return /model.*(not found|does not exist|unavailable|unknown)|not.?a.?valid.?model/i.test(
    hay,
  );
}

/**
 * Map provider HTTP failures to a short Thai line for banners.
 * @param providerLabel e.g. "DeepSeek", "OpenAI", "Anthropic", "Google AI"
 */
export function formatProviderHttpError(
  providerLabel: string,
  status: number,
  body: string,
): string {
  const label = String(providerLabel || "AI").trim() || "AI";
  const msg = extractProviderErrorMessage(body);
  const hay = `${msg} ${status}`.toLowerCase();
  const detail = sanitizeDetail(body, 80);

  if (status === 402 || looksInsufficientBalance(hay)) {
    return `${label}: เครดิต/ยอดเงินไม่พอ — เติมที่คอนโซลของเจ้านี้ หรือเปลี่ยนคีย์`;
  }

  if (status === 401 || status === 403 || looksInvalidKey(hay)) {
    if (looksInsufficientBalance(hay) || /credit|license|billing|quota|purchase|payment/i.test(hay)) {
      return `${label}: คีย์ใช้ได้แต่ยังไม่มีเครดิต/สิทธิ์ — เติมที่คอนโซลของเจ้านี้`;
    }
    return `${label}: API key หรือสิทธิ์ไม่ถูกต้อง`;
  }

  if (status === 429 || looksRateLimit(hay) || looksQuota(hay)) {
    if (looksRateLimit(hay) && !looksQuota(hay)) {
      return detail
        ? `${label}: เรียกถี่เกินไป — ${detail}`
        : `${label}: เรียกถี่เกินไป — รอสักครู่แล้วลองใหม่`;
    }
    if (looksQuota(hay)) {
      return detail
        ? `${label}: เกินโควต้าแล้ว — ${detail}`
        : `${label}: เกินโควต้าแล้ว — รอรีเซ็ตหรืออัปเกรดแผน`;
    }
    return detail
      ? `${label}: จำกัดการเรียก (429) — ${detail}`
      : `${label}: จำกัดการเรียก (429) — อาจเกินโควต้าหรือเรียกถี่เกินไป`;
  }

  // 404 alone is often a missing route (e.g. Cursor has no /v1/chat/completions),
  // not a wrong model id — only blame the model when the body says so.
  if (looksModelMissing(hay)) {
    return `${label}: โมเดลนี้ไม่มีหรือเลิกใช้แล้ว — เปลี่ยนโมเดล`;
  }
  if (status === 404) {
    return `${label}: ไม่พบ API/endpoint นี้ — ผู้ให้บริการนี้อาจยังไม่รองรับการเรียกแบบ chat completions`;
  }

  if (status === 503) {
    return `${label}: เซิร์ฟเวอร์โหลดสูงชั่วคราว — ลองใหม่หรือเปลี่ยนโมเดล`;
  }

  if (status >= 500) {
    return `${label}: เซิร์ฟเวอร์เจ้านี้มีปัญหาชั่วคราว (${status})`;
  }

  if (status === 400 && /model|context|token|length|too large|payload/i.test(hay)) {
    return detail
      ? `${label}: คำขอไม่ถูกต้อง — ${detail}`
      : `${label}: คำขอไม่ถูกต้อง — ตรวจโมเดลหรือขนาดไฟล์`;
  }

  return detail
    ? `${label} ตอบไม่สำเร็จ (${status || "?"}) — ${detail}`
    : `${label} ตอบไม่สำเร็จ (${status || "?"})`;
}
