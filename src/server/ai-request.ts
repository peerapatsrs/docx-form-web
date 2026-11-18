/**
 * Shared AI request helpers: configurable AbortController timeout + structured logs.
 * Never log API keys or document content.
 */

import { randomUUID } from "node:crypto";

export const AI_TIMEOUT_ENV = "DOCX_FORM_AI_TIMEOUT_MS";
/** Default 90s — long enough for Cloud Agent, short enough to avoid silent hangs. */
export const DEFAULT_AI_TIMEOUT_MS = 90_000;
const MIN_AI_TIMEOUT_MS = 5_000;
const MAX_AI_TIMEOUT_MS = 600_000;

/** Max retries after the first attempt (default 2 → 3 attempts total). */
export const AI_RETRY_MAX_ENV = "DOCX_FORM_AI_RETRY_MAX";
export const DEFAULT_AI_RETRY_MAX = 2;
const MIN_AI_RETRY_MAX = 0;
const MAX_AI_RETRY_MAX = 4;

/** Base backoff between retries (ms); attempt n waits backoff * n. */
export const AI_RETRY_BACKOFF_MS_ENV = "DOCX_FORM_AI_RETRY_BACKOFF_MS";
export const DEFAULT_AI_RETRY_BACKOFF_MS = 1_500;
const MIN_AI_RETRY_BACKOFF_MS = 0;
const MAX_AI_RETRY_BACKOFF_MS = 30_000;

/**
 * Wall-clock budget across all attempts (ms). When unset, derived from
 * per-attempt timeout × attempts + backoff sum, capped at MAX_AI_TIMEOUT_MS * 3.
 */
export const AI_OVERALL_TIMEOUT_ENV = "DOCX_FORM_AI_OVERALL_TIMEOUT_MS";
const MIN_AI_OVERALL_TIMEOUT_MS = 10_000;
const MAX_AI_OVERALL_TIMEOUT_MS = 900_000;

/**
 * Optional size scaling: extra ms per MiB of payload above the soft floor.
 * Unset → default 8s/MiB; set to 0 to disable.
 */
export const AI_TIMEOUT_EXTRA_MS_PER_MIB_ENV =
  "DOCX_FORM_AI_TIMEOUT_EXTRA_MS_PER_MIB";
export const DEFAULT_AI_TIMEOUT_EXTRA_MS_PER_MIB = 8_000;
/** Soft floor before size scaling kicks in (256 KiB). */
export const AI_TIMEOUT_SCALE_SOFT_BYTES = 256 * 1024;

export class AiTimeoutError extends Error {
  readonly code = "AI_TIMEOUT";
  constructor(message?: string) {
    super(
      message ||
        "AI_TIMEOUT: ผู้ให้บริการ AI ไม่ตอบภายในเวลาที่กำหนด — ลองใหม่หรือเปลี่ยนโมเดล",
    );
    this.name = "AiTimeoutError";
  }
}

/**
 * Parse a clamped int from env. Unset / blank MUST return {@link fallback}
 * (do not treat Number("") === 0 as a deliberate zero when min allows 0).
 */
export function parseEnvInt(
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = String(process.env[envName] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= min && n <= max) {
    return Math.floor(n);
  }
  return fallback;
}

export function getAiTimeoutMs(): number {
  return parseEnvInt(
    AI_TIMEOUT_ENV,
    DEFAULT_AI_TIMEOUT_MS,
    MIN_AI_TIMEOUT_MS,
    MAX_AI_TIMEOUT_MS,
  );
}

/** Extra ms per MiB above {@link AI_TIMEOUT_SCALE_SOFT_BYTES}; 0 disables scaling. */
export function getAiTimeoutExtraMsPerMiB(): number {
  const raw = String(process.env[AI_TIMEOUT_EXTRA_MS_PER_MIB_ENV] || "").trim();
  if (raw === "") return DEFAULT_AI_TIMEOUT_EXTRA_MS_PER_MIB;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AI_TIMEOUT_EXTRA_MS_PER_MIB;
  return Math.min(Math.floor(n), 60_000);
}

/**
 * Per-attempt timeout: base {@link getAiTimeoutMs} plus optional size scaling.
 * Never exceeds MAX_AI_TIMEOUT_MS.
 */
export function getAiTimeoutMsForPayload(payloadBytes?: number | null): number {
  const base = getAiTimeoutMs();
  const bytes =
    typeof payloadBytes === "number" && Number.isFinite(payloadBytes)
      ? Math.max(0, Math.floor(payloadBytes))
      : 0;
  const extraPerMiB = getAiTimeoutExtraMsPerMiB();
  if (!extraPerMiB || bytes <= AI_TIMEOUT_SCALE_SOFT_BYTES) {
    return base;
  }
  const overBytes = bytes - AI_TIMEOUT_SCALE_SOFT_BYTES;
  const extraMs = Math.floor((overBytes / (1024 * 1024)) * extraPerMiB);
  return Math.min(MAX_AI_TIMEOUT_MS, base + Math.max(0, extraMs));
}

/** Retries after the first failure (0 = no retry). */
export function getAiRetryMax(): number {
  return parseEnvInt(
    AI_RETRY_MAX_ENV,
    DEFAULT_AI_RETRY_MAX,
    MIN_AI_RETRY_MAX,
    MAX_AI_RETRY_MAX,
  );
}

export function getAiRetryBackoffMs(): number {
  return parseEnvInt(
    AI_RETRY_BACKOFF_MS_ENV,
    DEFAULT_AI_RETRY_BACKOFF_MS,
    MIN_AI_RETRY_BACKOFF_MS,
    MAX_AI_RETRY_BACKOFF_MS,
  );
}

/**
 * Overall wall budget for retries. Env override when valid; otherwise
 * perAttempt × attempts + backoff sum, capped.
 */
export function getAiOverallTimeoutMs(
  perAttemptMs: number = getAiTimeoutMs(),
  retryMax: number = getAiRetryMax(),
  backoffMs: number = getAiRetryBackoffMs(),
): number {
  const attempts = Math.max(1, retryMax + 1);
  const derived =
    perAttemptMs * attempts +
    backoffMs * Math.max(0, attempts - 1) * ((attempts) / 2);
  const capped = Math.min(
    MAX_AI_OVERALL_TIMEOUT_MS,
    Math.max(MIN_AI_OVERALL_TIMEOUT_MS, Math.floor(derived)),
  );
  return parseEnvInt(
    AI_OVERALL_TIMEOUT_ENV,
    capped,
    MIN_AI_OVERALL_TIMEOUT_MS,
    MAX_AI_OVERALL_TIMEOUT_MS,
  );
}

export function isAiTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof AiTimeoutError) return true;
  if (typeof err === "object" && err && "code" in err) {
    if (String((err as { code?: unknown }).code || "") === "AI_TIMEOUT") {
      return true;
    }
  }
  if (err instanceof Error) {
    return (
      err.name === "AiTimeoutError" ||
      /^AI_TIMEOUT\b/i.test(err.message) ||
      err.message === "AI_TIMEOUT"
    );
  }
  return typeof err === "string" && /^AI_TIMEOUT\b/i.test(err);
}

export function getOrCreateRequestId(req?: Request | null): string {
  const fromHeader = String(req?.headers.get("x-request-id") || "")
    .trim()
    .slice(0, 64);
  if (fromHeader) return fromHeader;
  return randomUUID();
}

export type AiCallLogFields = {
  route?: string | null;
  provider?: string | null;
  model?: string | null;
  durationMs?: number | null;
  errorClass?: string | null;
  requestId?: string | null;
  outcome?: "start" | "ok" | "error" | "timeout" | string | null;
  phase?: string | null;
};

/** One structured JSON line for container logs (no secrets / no doc body). */
export function logAiCall(fields: AiCallLogFields): void {
  const line = {
    msg: "ai_call",
    route: fields.route || null,
    provider: fields.provider || null,
    model: fields.model || null,
    durationMs:
      typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs)
        ? Math.round(fields.durationMs)
        : null,
    errorClass: fields.errorClass || null,
    requestId: fields.requestId || null,
    outcome: fields.outcome || null,
    phase: fields.phase || null,
  };
  console.log(JSON.stringify(line));
}

export function createAiTimeoutController(
  outer?: AbortSignal | null,
  timeoutMs: number = getAiTimeoutMs(),
): {
  controller: AbortController;
  signal: AbortSignal;
  clear: () => void;
  timedOut: () => boolean;
  timeoutMs: number;
} {
  const controller = new AbortController();
  let timedOut = false;
  // Trust explicit timeoutMs from callers/tests; env path is already clamped
  // in getAiTimeoutMs. Keep a tiny floor so setTimeout(0) is not accidental.
  const ms = Math.max(50, Math.floor(timeoutMs));

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort(new AiTimeoutError());
    } catch {
      controller.abort();
    }
  }, ms);

  const onOuter = () => {
    try {
      controller.abort(outer?.reason);
    } catch {
      controller.abort();
    }
  };
  if (outer) {
    if (outer.aborted) onOuter();
    else outer.addEventListener("abort", onOuter, { once: true });
  }

  return {
    controller,
    signal: controller.signal,
    timeoutMs: ms,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onOuter);
    },
  };
}

export type WithAiTimeoutOpts = {
  signal?: AbortSignal | null;
  timeoutMs?: number;
  route?: string;
  provider?: string;
  model?: string;
  requestId?: string;
};

/**
 * Run an AI provider call under a mandatory processing-time AbortController.
 * On timeout throws {@link AiTimeoutError} with code AI_TIMEOUT.
 */
export async function withAiTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  opts: WithAiTimeoutOpts = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? getAiTimeoutMs();
  const started = Date.now();
  const gate = createAiTimeoutController(opts.signal, timeoutMs);
  try {
    const result = await run(gate.signal);
    logAiCall({
      route: opts.route,
      provider: opts.provider,
      model: opts.model,
      requestId: opts.requestId,
      durationMs: Date.now() - started,
      outcome: "ok",
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - started;
    const timedOut =
      gate.timedOut() ||
      isAiTimeoutError(err) ||
      isAiTimeoutError(gate.signal.reason);
    const errorClass = timedOut
      ? "AI_TIMEOUT"
      : err instanceof Error
        ? err.name || "Error"
        : "Unknown";
    logAiCall({
      route: opts.route,
      provider: opts.provider,
      model: opts.model,
      requestId: opts.requestId,
      durationMs,
      errorClass,
      outcome: timedOut ? "timeout" : "error",
    });
    if (timedOut) {
      throw new AiTimeoutError(
        `AI_TIMEOUT: ผู้ให้บริการ AI ไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที — ลองใหม่หรือเปลี่ยนโมเดล`,
      );
    }
    throw err;
  } finally {
    gate.clear();
  }
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("aborted"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorStatus(err: unknown): number {
  if (typeof err === "object" && err && "status" in err) {
    const n = Number((err as { status?: unknown }).status);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof err === "object" && err && "statusHint" in err) {
    const n = Number((err as { statusHint?: unknown }).statusHint);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function errorCode(err: unknown): string {
  if (typeof err === "object" && err && "code" in err) {
    return String((err as { code?: unknown }).code || "");
  }
  return "";
}

/**
 * True for timeouts and transient upstream failures only.
 * Never retries auth (401/403), client 4xx, or quota/key errors.
 */
export function isRetryableAiError(err: unknown): boolean {
  if (!err) return false;
  if (isAiTimeoutError(err)) return true;

  const status = errorStatus(err);
  if (status === 401 || status === 403 || status === 400 || status === 404) {
    return false;
  }
  if (status === 402) return false;
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (status >= 500 && status < 600) return true;

  const code = errorCode(err);
  if (
    code === "AI_KEY_INVALID" ||
    code === "AI_AUTH" ||
    code === "AI_SERVER_KEY_INVALID" ||
    code === "AI_PROVIDER_AUTH" ||
    code === "AI_PROVIDER_BAD_REQUEST" ||
    code === "AI_PROVIDER_QUOTA"
  ) {
    return false;
  }
  if (
    code === "AI_PROVIDER_TIMEOUT" ||
    code === "AI_PROVIDER_UNAVAILABLE" ||
    code === "AI_PROVIDER_RATE_LIMIT" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }

  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err || "");
  if (
    /API key|สิทธิ์ไม่ถูกต้อง|หมดอายุ|Authentication|unauthorized|Invalid User API Key|invalid.?api.?key|AI_KEY_INVALID|AI_AUTH/i.test(
      msg,
    )
  ) {
    return false;
  }
  if (
    /คำขอไม่ถูกต้อง|โมเดลนี้ไม่มี|ไม่พบ API|BAD_REQUEST|เครดิต\/โควต้าหมด|เกินโควต้า/i.test(
      msg,
    )
  ) {
    return false;
  }
  if (
    /เรียกถี่เกินไป|เซิร์ฟเวอร์โหลดสูง|เซิร์ฟเวอร์เจ้านี้มีปัญหา|หมดเวลารอผู้ให้บริการ|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network|socket hang up|UND_ERR_/i.test(
      msg,
    )
  ) {
    return true;
  }
  // Bare 5xx phrasing from formatProviderHttpError without status field.
  if (/\(\s*5\d\d\s*\)/.test(msg)) return true;
  return false;
}

export type WithAiRetryOpts = {
  signal?: AbortSignal | null;
  /** Base/per-attempt timeout; defaults to size-scaled getAiTimeoutMsForPayload. */
  timeoutMs?: number;
  payloadBytes?: number | null;
  retryMax?: number;
  backoffMs?: number;
  overallTimeoutMs?: number;
  route?: string;
  provider?: string;
  model?: string;
  requestId?: string;
};

/**
 * Bounded retry with linear backoff for timeouts / transient upstream errors.
 * Honors an overall wall budget so the client never waits forever.
 * Caller applies per-attempt timeout via the `timeoutMs` argument (typically
 * {@link withAiTimeout}); this helper does not nest a second timer on `run`.
 * Final error codes/messages are unchanged (same throw as the last attempt).
 */
export async function withAiRetry<T>(
  run: (signal: AbortSignal, attempt: number, timeoutMs: number) => Promise<T>,
  opts: WithAiRetryOpts = {},
): Promise<T> {
  const retryMax = opts.retryMax ?? getAiRetryMax();
  const backoffMs = opts.backoffMs ?? getAiRetryBackoffMs();
  const perAttempt =
    opts.timeoutMs ?? getAiTimeoutMsForPayload(opts.payloadBytes);
  const overall =
    opts.overallTimeoutMs ??
    getAiOverallTimeoutMs(perAttempt, retryMax, backoffMs);
  const attempts = Math.max(1, retryMax + 1);
  const started = Date.now();
  const overallGate = createAiTimeoutController(opts.signal, overall);
  let lastErr: unknown;

  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (overallGate.signal.aborted) {
        if (isAiTimeoutError(overallGate.signal.reason) || overallGate.timedOut()) {
          throw (
            lastErr ||
            new AiTimeoutError(
              `AI_TIMEOUT: ผู้ให้บริการ AI ไม่ตอบภายใน ${Math.round(overall / 1000)} วินาที — ลองใหม่หรือเปลี่ยนโมเดล`,
            )
          );
        }
        throw overallGate.signal.reason || lastErr || new Error("aborted");
      }
      const elapsed = Date.now() - started;
      const remaining = overall - elapsed;
      if (remaining <= 50) {
        throw (
          lastErr ||
          new AiTimeoutError(
            `AI_TIMEOUT: ผู้ให้บริการ AI ไม่ตอบภายใน ${Math.round(overall / 1000)} วินาที — ลองใหม่หรือเปลี่ยนโมเดล`,
          )
        );
      }
      const attemptTimeout = Math.min(perAttempt, remaining);
      const attemptStarted = Date.now();
      try {
        const result = await run(
          overallGate.signal,
          attempt,
          attemptTimeout,
        );
        if (attempt > 1) {
          logAiCall({
            route: opts.route,
            provider: opts.provider,
            model: opts.model,
            requestId: opts.requestId,
            durationMs: Date.now() - started,
            outcome: "ok",
            phase: `retry_ok_${attempt}`,
          });
        }
        return result;
      } catch (err) {
        lastErr = err;
        const retryable = isRetryableAiError(err);
        const clientAborted =
          Boolean(opts.signal?.aborted) &&
          !overallGate.timedOut() &&
          !isAiTimeoutError(err);
        const isLast = attempt >= attempts;
        logAiCall({
          route: opts.route,
          provider: opts.provider,
          model: opts.model,
          requestId: opts.requestId,
          durationMs: Date.now() - attemptStarted,
          errorClass: isAiTimeoutError(err)
            ? "AI_TIMEOUT"
            : err instanceof Error
              ? err.name || "Error"
              : "Unknown",
          outcome: isAiTimeoutError(err) ? "timeout" : "error",
          phase: `attempt_${attempt}${retryable && !isLast ? "_retry" : "_final"}`,
        });
        if (!retryable || isLast || clientAborted) {
          throw err;
        }
        const wait = backoffMs * attempt;
        const afterWaitRemaining = overall - (Date.now() - started) - wait;
        if (afterWaitRemaining <= 50) {
          throw err;
        }
        try {
          await sleep(wait, overallGate.signal);
        } catch (abortErr) {
          if (overallGate.timedOut() || isAiTimeoutError(abortErr)) {
            throw err;
          }
          throw opts.signal?.aborted ? abortErr : err;
        }
      }
    }
    throw lastErr;
  } finally {
    overallGate.clear();
  }
}

/** JSON body helpers for AI routes. */
export function aiTimeoutJsonBody(err: AiTimeoutError | Error): {
  error: string;
  code: string;
} {
  return {
    code: "AI_TIMEOUT",
    error:
      err instanceof Error
        ? err.message
        : "AI_TIMEOUT: ผู้ให้บริการ AI ไม่ตอบภายในเวลาที่กำหนด",
  };
}

export function aiProviderErrorJsonBody(
  err: unknown,
  opts?: {
    usedSharedEnvFallback?: boolean;
    keySource?: "user" | "shared" | "none" | null;
    providerLabel?: string | null;
  },
): {
  error: string;
  code: string;
} {
  if (isAiTimeoutError(err)) {
    return aiTimeoutJsonBody(
      err instanceof Error ? err : new AiTimeoutError(String(err)),
    );
  }
  const message = err instanceof Error ? err.message : String(err || "AI error");
  const isAuth =
    /API key|สิทธิ์ไม่ถูกต้อง|หมดอายุ|Authentication|unauthorized|Invalid User API Key|invalid.?api.?key/i.test(
      message,
    );
  const usedShared =
    Boolean(opts?.usedSharedEnvFallback) || opts?.keySource === "shared";
  if (isAuth && usedShared) {
    // Keep message here (ai-config imports this module — no circular import).
    const label = String(opts?.providerLabel || "").trim();
    return {
      code: "AI_SERVER_KEY_INVALID",
      error: label
        ? `คีย์เซิร์ฟเวอร์ (${label}) ถูกผู้ให้บริการปฏิเสธ — ไม่ใช่คีย์ส่วนตัวของคุณ แจ้งผู้ดูแลระบบให้ตรวจคีย์เซิร์ฟเวอร์`
        : "คีย์เซิร์ฟเวอร์ถูกผู้ให้บริการปฏิเสธ — ไม่ใช่คีย์ส่วนตัวของคุณ แจ้งผู้ดูแลระบบให้ตรวจคีย์เซิร์ฟเวอร์",
    };
  }
  const code = isAuth ? "AI_AUTH" : "AI_PROVIDER_ERROR";
  return { code, error: message };
}
