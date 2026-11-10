/**
 * Short Thai-friendly AI provider HTTP errors for UI banners.
 * Shared classifier → stable codes (one mapper for all AI routes).
 * Never dump raw JSON (e.g. DeepSeek 402 Insufficient Balance).
 * Never blame credits/quota unless the provider message actually says so.
 */

const UI_MSG_MAX = 90;

type ProviderErrorBody = {
  error?: string | { message?: string; code?: string | number; type?: string };
  message?: string;
  code?: string | number;
};

/** Stable codes for Frontend TH/EN maps. */
export type AiProviderErrorCode =
  | "AI_KEY_INVALID"
  | "AI_KEY_UNAUTHORIZED"
  | "AI_PROVIDER_AUTH"
  | "AI_PROVIDER_RATE_LIMIT"
  | "AI_PROVIDER_QUOTA"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_BAD_REQUEST"
  | "AI_PROVIDER_ERROR";

export type ClassifiedProviderError = {
  code: AiProviderErrorCode;
  message: string;
  statusHint?: number;
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

export function looksInvalidKey(hay: string): boolean {
  return /invalid.?api.?key|incorrect api key|api key not valid|invalid user api key|unauthorized|authentication|permission.?denied|invalid.?key|wrong api key|expired.?key|หมดอายุ|ไม่ถูกต้องหรือหมดอายุ|ยังไม่ได้ใส่ API key/i.test(
    hay,
  );
}

/** True when an AI provider error is auth/key rejection (not quota/model/etc.). */
export function isAiCredentialAuthError(err: unknown): boolean {
  if (!err) return false;
  const status =
    typeof err === "object" && err && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  if (status === 401 || status === 403) return true;
  const hay =
    err instanceof Error
      ? `${err.name} ${err.message}`
      : typeof err === "string"
        ? err
        : String(err);
  if (
    /API key หรือสิทธิ์ไม่ถูกต้อง|API key ไม่ถูกต้องหรือหมดอายุ|AI_KEY_INVALID|AI_PROVIDER_AUTH/i.test(
      hay,
    )
  ) {
    return true;
  }
  return looksInvalidKey(hay);
}

function looksQuotaExhausted(hay: string): boolean {
  // Only when the provider clearly says quota/credits are exhausted — not generic "billing".
  return /exceeded your current quota|quota exceeded|free_tier.*exhaust|out of credits|no credits|insufficient[_\s-]?credits|insufficient[_\s-]?balance|resource_exhausted|usage.?limit.?exceeded|generaterequestsperday|generate_requests/i.test(
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

function looksTimeout(hay: string): boolean {
  return /timeout|timed?\s*out|AI_TIMEOUT|หมดเวลา|ETIMEDOUT|AbortError/i.test(hay);
}

function looksUnavailable(hay: string, status: number): boolean {
  return (
    status === 503 ||
    status === 502 ||
    status >= 500 ||
    /unavailable|overloaded|service.?unavailable|server.?error|ECONNREFUSED|ENOTFOUND/i.test(
      hay,
    )
  );
}

/**
 * One shared mapper: HTTP status + body/message → stable code + Thai message.
 * Credits/quota only when the provider text actually indicates exhaustion.
 */
export function classifyProviderError(opts: {
  providerLabel?: string;
  status?: number;
  body?: string;
  err?: unknown;
}): ClassifiedProviderError {
  const label = String(opts.providerLabel || "AI").trim() || "AI";
  const status =
    typeof opts.status === "number" && Number.isFinite(opts.status)
      ? opts.status
      : typeof opts.err === "object" &&
          opts.err &&
          "status" in opts.err &&
          Number.isFinite(Number((opts.err as { status?: unknown }).status))
        ? Number((opts.err as { status?: unknown }).status)
        : 0;
  const fromErr =
    opts.err instanceof Error
      ? opts.err.message
      : typeof opts.err === "string"
        ? opts.err
        : "";
  const msg = extractProviderErrorMessage(opts.body || "") || fromErr;
  const hay = `${msg} ${status} ${fromErr}`.toLowerCase();
  const detail = sanitizeDetail(opts.body || fromErr, 80);

  if (looksTimeout(hay) || status === 504) {
    return {
      code: "AI_PROVIDER_TIMEOUT",
      message: detail
        ? `${label}: หมดเวลา — ${detail}`
        : `${label}: หมดเวลารอผู้ให้บริการ — ลองใหม่ภายหลัง`,
      statusHint: 504,
    };
  }

  if (status === 402 || looksInsufficientBalance(hay) || looksQuotaExhausted(hay)) {
    return {
      code: "AI_PROVIDER_QUOTA",
      message: detail
        ? `${label}: เครดิต/โควต้าหมด — ${detail}`
        : `${label}: เครดิต/โควต้าหมด — เติมที่คอนโซลของเจ้านี้ หรือเปลี่ยนคีย์`,
      statusHint: status || 402,
    };
  }

  if (status === 401 || status === 403 || looksInvalidKey(hay)) {
    // Only mention credits when the body explicitly says so (not generic "billing").
    if (looksInsufficientBalance(hay) || looksQuotaExhausted(hay)) {
      return {
        code: "AI_PROVIDER_QUOTA",
        message: `${label}: คีย์ใช้ได้แต่เครดิต/โควต้าไม่พอ — เติมที่คอนโซลของเจ้านี้`,
        statusHint: status || 403,
      };
    }
    return {
      code: "AI_KEY_INVALID",
      message: `${label}: API key หรือสิทธิ์ไม่ถูกต้อง`,
      statusHint: status || 401,
    };
  }

  if (status === 429 || looksRateLimit(hay)) {
    // 429 alone is rate-limit unless body clearly says quota exhausted.
    if (looksQuotaExhausted(hay)) {
      return {
        code: "AI_PROVIDER_QUOTA",
        message: detail
          ? `${label}: เกินโควต้าแล้ว — ${detail}`
          : `${label}: เกินโควต้าแล้ว — รอรีเซ็ตหรืออัปเกรดแผน`,
        statusHint: 429,
      };
    }
    return {
      code: "AI_PROVIDER_RATE_LIMIT",
      message: detail
        ? `${label}: เรียกถี่เกินไป — ${detail}`
        : `${label}: เรียกถี่เกินไป — รอสักครู่แล้วลองใหม่`,
      statusHint: 429,
    };
  }

  if (looksModelMissing(hay)) {
    return {
      code: "AI_PROVIDER_BAD_REQUEST",
      message: `${label}: โมเดลนี้ไม่มีหรือเลิกใช้แล้ว — เปลี่ยนโมเดล`,
      statusHint: status || 400,
    };
  }

  if (status === 404) {
    return {
      code: "AI_PROVIDER_BAD_REQUEST",
      message: `${label}: ไม่พบ API/endpoint นี้ — ผู้ให้บริการนี้อาจยังไม่รองรับการเรียกแบบนี้`,
      statusHint: 404,
    };
  }

  if (looksUnavailable(hay, status)) {
    return {
      code: "AI_PROVIDER_UNAVAILABLE",
      message:
        status === 503
          ? `${label}: เซิร์ฟเวอร์โหลดสูงชั่วคราว — ลองใหม่หรือเปลี่ยนโมเดล`
          : `${label}: เซิร์ฟเวอร์เจ้านี้มีปัญหาชั่วคราว (${status || "?"})`,
      statusHint: status || 503,
    };
  }

  if (status === 400) {
    return {
      code: "AI_PROVIDER_BAD_REQUEST",
      message: detail
        ? `${label}: คำขอไม่ถูกต้อง — ${detail}`
        : `${label}: คำขอไม่ถูกต้อง — ตรวจโมเดลหรือขนาดไฟล์`,
      statusHint: 400,
    };
  }

  return {
    code: "AI_PROVIDER_ERROR",
    message: detail
      ? `${label} ตอบไม่สำเร็จ (${status || "?"}) — ${detail}`
      : `${label} ตอบไม่สำเร็จ (${status || "?"})`,
    statusHint: status || 400,
  };
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
  return classifyProviderError({ providerLabel, status, body }).message;
}

/** Alias used by model-list / connect flows — same mapper, never invents credits. */
export function formatModelsListError(
  providerLabel: string,
  status: number,
  body: string,
): string {
  const classified = classifyProviderError({ providerLabel, status, body });
  if (classified.code === "AI_KEY_INVALID") {
    return `${String(providerLabel || "AI").trim() || "AI"}: คีย์ไม่มีสิทธิ์ดึงรายการโมเดล (ตรวจคีย์หรือสิทธิ์บัญชี)`;
  }
  if (classified.code === "AI_PROVIDER_ERROR" && status && status < 500) {
    const detail = sanitizeDetail(body, 90);
    if (detail) {
      return `${String(providerLabel || "AI").trim() || "AI"}: ดึงโมเดลไม่สำเร็จ — ${detail}`;
    }
  }
  return classified.message;
}
