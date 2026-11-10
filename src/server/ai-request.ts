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

export function getAiTimeoutMs(): number {
  const raw = String(process.env[AI_TIMEOUT_ENV] || "").trim();
  const n = Number(raw);
  if (Number.isFinite(n) && n >= MIN_AI_TIMEOUT_MS && n <= MAX_AI_TIMEOUT_MS) {
    return Math.floor(n);
  }
  return DEFAULT_AI_TIMEOUT_MS;
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

export function aiProviderErrorJsonBody(err: unknown): {
  error: string;
  code: string;
} {
  if (isAiTimeoutError(err)) {
    return aiTimeoutJsonBody(
      err instanceof Error ? err : new AiTimeoutError(String(err)),
    );
  }
  const message = err instanceof Error ? err.message : String(err || "AI error");
  const code =
    /API key|สิทธิ์ไม่ถูกต้อง|หมดอายุ|Authentication|unauthorized/i.test(message)
      ? "AI_AUTH"
      : "AI_PROVIDER_ERROR";
  return { code, error: message };
}
