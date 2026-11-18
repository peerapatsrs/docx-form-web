/**
 * Cursor BYOK via @cursor/sdk Cloud Agent (no-repo).
 * Not OpenAI-compatible chat — put document text in the prompt and parse JSON from result.result.
 * @see https://cursor.com/docs/sdk/typescript
 */

import {
  Agent,
  AuthenticationError,
  ConfigurationError,
  Cursor,
  CursorSdkError,
} from "@cursor/sdk";
import {
  CURSOR_STALE_MODEL_IDS,
  getAiProvider,
  resolveCursorModelId,
} from "./ai-providers";
import {
  AiTimeoutError,
  getAiTimeoutMs,
  isAiTimeoutError,
  withAiTimeout,
} from "./ai-request";

export type CursorAgentImage = {
  mimeType: string;
  base64: string;
};

export type CallCursorAgentJsonOpts = {
  apiKey: string;
  model: string;
  images?: CursorAgentImage[];
  /** Optional cancel — merged with DOCX_FORM_AI_TIMEOUT_MS processing-time cap. */
  signal?: AbortSignal;
  /** Override DOCX_FORM_AI_TIMEOUT_MS (tests / special routes). */
  timeoutMs?: number;
  /** Structured log context (never secrets / doc body). */
  route?: string;
  requestId?: string;
};

/** Live model ids for the API key (empty on failure / timeout). */
export async function listCursorModelIds(
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const key = String(apiKey || "").trim();
  if (!key) return [];
  try {
    // Catalog list should not burn the full AI timeout — cap at 15s.
    const listTimeout = Math.min(15_000, getAiTimeoutMs());
    return await withAiTimeout(
      async (gated) => {
        const models = await Cursor.models.list({ apiKey: key });
        if (gated.aborted) return [];
        return (models || [])
          .map((m) => String(m?.id || "").trim())
          .filter(Boolean);
      },
      {
        signal,
        timeoutMs: listTimeout,
        route: "cursor.models.list",
        provider: "cursor",
      },
    );
  } catch {
    return [];
  }
}

function cursorStaticCatalogIds(): string[] {
  const provider = getAiProvider("cursor");
  const ids = (provider?.models || []).map((m) => m.id).filter(Boolean);
  return ids.length ? ids : ["composer-2.5"];
}

/** True when id clearly belongs to another provider family (never send to Cursor Agent). */
export function isCrossFamilyCursorModelId(raw: string | null | undefined): boolean {
  const id = String(raw || "").trim();
  if (!id) return false;
  return /^(gemini|gpt-|o[1-9]|chatgpt|claude|deepseek|grok|mistral|llama|qwen)/i.test(
    id,
  );
}

/**
 * Resolve vault/header model for Agent.create.
 * Stale/gated/cross-family ids remap via static catalog immediately — never wait
 * on a hung models.list, and never pass gemini-* through to Agent.prompt.
 */
export async function resolveCursorModelForCall(
  apiKey: string,
  requested: string | null | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const raw = String(requested || "").trim();
  const catalog = cursorStaticCatalogIds();

  if (!raw || CURSOR_STALE_MODEL_IDS.has(raw) || isCrossFamilyCursorModelId(raw)) {
    return resolveCursorModelId(raw, catalog);
  }

  const available = await listCursorModelIds(apiKey, signal);
  if (available.length) {
    return resolveCursorModelId(raw, available);
  }
  // Live list empty/failed — still bind to static catalog so unknown leftovers
  // (or flaky catalog) cannot hang Agent.prompt on an invalid model id.
  return resolveCursorModelId(raw, catalog);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced ? fenced[1] : raw).trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      if (Array.isArray(parsed)) return { _legacy: parsed };
    } catch {
      /* ignore */
    }
    return null;
  };
  const direct = tryParse(body);
  if (direct) return direct;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(body.slice(start, end + 1));
  return null;
}

async function waitWithOptionalAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    if (isAiTimeoutError(signal.reason)) throw new AiTimeoutError();
    throw new Error("CURSOR_AGENT_CANCELLED");
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (isAiTimeoutError(signal.reason)) reject(new AiTimeoutError());
      else reject(new Error("CURSOR_AGENT_CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function haystackFromUnknown(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const extra =
      "code" in err && (err as { code?: unknown }).code != null
        ? ` ${String((err as { code?: unknown }).code)}`
        : "";
    return `${err.name} ${err.message}${extra}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Map SDK / cloud failures to short Thai errors for UI banners. */
export function formatCursorAgentError(err: unknown): Error {
  if (isAiTimeoutError(err)) {
    return err instanceof AiTimeoutError
      ? err
      : new AiTimeoutError(
          err instanceof Error ? err.message : String(err || "AI_TIMEOUT"),
        );
  }
  if (err instanceof Error && err.message.startsWith("Cursor:")) {
    return err;
  }
  const hay = haystackFromUnknown(err);

  if (
    err instanceof Error &&
    (err.message === "CURSOR_AGENT_CANCELLED" ||
      /CURSOR_AGENT_CANCELLED/i.test(hay))
  ) {
    return new Error("Cursor: ยกเลิกแล้ว");
  }

  if (
    err instanceof AuthenticationError ||
    /authentication|unauthorized|invalid.?api.?key|api key/i.test(hay)
  ) {
    return new Error(
      "Cursor: API key ไม่ถูกต้องหรือหมดอายุ — ตรวจคีย์ crsr_… ที่ Dashboard → API Keys",
    );
  }

  if (
    /no-?repo|empty.?repos|repos:\s*\[\]|not enabled|feature not enabled|repository-scoped|unrestricted/i.test(
      hay,
    )
  ) {
    return new Error(
      "Cursor: บัญชียังไม่เปิด no-repo Cloud Agents — ใช้คีย์ผู้ใช้ (ไม่ใช่ repo-scoped) หรือเปิดสิทธิ์ในทีม",
    );
  }

  if (
    /quota|rate.?limit|usage.?limit|spend|billing|insufficient|out of credits|request.?limit|too many requests/i.test(
      hay,
    )
  ) {
    return new Error(
      "Cursor: โควต้าหรือเครดิตไม่พอ — ตรวจ usage ใน Dashboard แล้วลองใหม่ภายหลัง",
    );
  }

  if (
    /not available or invalid|Call Cursor\.models\.list|invalid.?model|model.*invalid|unknown model/i.test(
      hay,
    )
  ) {
    return new Error(
      "Cursor: โมเดลที่เลือกใช้ไม่ได้กับคีย์นี้ — เปิด「เลือก model」แล้วเลือกใหม่จากรายการ (เช่น Composer 2.5)",
    );
  }

  if (err instanceof ConfigurationError) {
    if (
      /not available or invalid|Call Cursor\.models\.list|invalid.?model|model.*invalid/i.test(
        err.message,
      )
    ) {
      return new Error(
        "Cursor: โมเดลที่เลือกใช้ไม่ได้กับคีย์นี้ — เปิด「เลือก model」แล้วเลือกใหม่จากรายการ (เช่น Composer 2.5)",
      );
    }
    const detail = err.message.replace(/\s+/g, " ").trim().slice(0, 120);
    return new Error(
      detail
        ? `Cursor: การตั้งค่า SDK ไม่ถูกต้อง — ${detail}`
        : "Cursor: การตั้งค่า SDK ไม่ถูกต้อง",
    );
  }

  if (err instanceof CursorSdkError) {
    if (
      /not available or invalid|Call Cursor\.models\.list|invalid.?model|model.*invalid/i.test(
        err.message,
      )
    ) {
      return new Error(
        "Cursor: โมเดลที่เลือกใช้ไม่ได้กับคีย์นี้ — เปิด「เลือก model」แล้วเลือกใหม่จากรายการ (เช่น Composer 2.5)",
      );
    }
    const detail = err.message.replace(/\s+/g, " ").trim().slice(0, 120);
    return new Error(
      detail ? `Cursor: ${detail}` : "Cursor: Cloud Agent ล้มเหลว",
    );
  }

  const detail = hay.replace(/\s+/g, " ").trim().slice(0, 120);
  return new Error(
    detail
      ? `Cursor: Cloud Agent ล้มเหลว — ${detail}`
      : "Cursor: Cloud Agent ล้มเหลว",
  );
}

/**
 * Local mock modes for CI / VM without a real Cursor key.
 * DOCX_FORM_CURSOR_AGENT_MOCK=ok|hang|401
 */
async function maybeMockCursorAgentJson(
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null | undefined> {
  const mode = String(process.env.DOCX_FORM_CURSOR_AGENT_MOCK || "")
    .trim()
    .toLowerCase();
  if (!mode) return undefined;
  if (mode === "hang" || mode === "never") {
    await waitWithOptionalAbort(new Promise<never>(() => {}), signal);
    return null;
  }
  if (mode === "401" || mode === "auth") {
    throw new AuthenticationError("Invalid API key (mock)", {
      status: 401,
      code: "AUTH_INVALID_API_KEY",
    });
  }
  if (mode === "ok" || mode === "success") {
    return {
      suggestions: [
        {
          name: "ชื่อ",
          kind: "text",
          preview: "ชื่อ",
          reason: "mock",
        },
      ],
      values: { ชื่อ: "ตัวอย่าง" },
      mock: true,
    };
  }
  return undefined;
}

/**
 * One-shot cloud no-repo agent → parse assistant text as JSON object.
 * Text-only uses Agent.prompt; images use create + send (vision).
 * Always bounded by DOCX_FORM_AI_TIMEOUT_MS (default 90s).
 */
export async function callCursorAgentJson(
  prompt: string,
  opts: CallCursorAgentJsonOpts,
): Promise<Record<string, unknown> | null> {
  const apiKey = String(opts.apiKey || "").trim();
  if (!apiKey) throw new Error("ยังไม่ได้ใส่ API key");

  const message = String(prompt || "").trim();
  if (!message) throw new Error("ไม่มีข้อความให้ส่งไป Cursor Agent");

  const images = (opts.images || [])
    .filter((img) => img?.base64 && img?.mimeType)
    .slice(0, 12);

  try {
    return await withAiTimeout(
      async (signal) => {
        const mocked = await maybeMockCursorAgentJson(signal);
        if (mocked !== undefined) return mocked;

        const model = await resolveCursorModelForCall(
          apiKey,
          opts.model,
          signal,
        );
        if (!model) throw new Error("ยังไม่ได้เลือกโมเดล");

        const agentOpts = {
          apiKey,
          model: { id: model },
          cloud: { repos: [] as [] },
        };

        let resultText = "";

        if (images.length) {
          const agent = await Agent.create(agentOpts);
          try {
            const run = await agent.send({
              text: message,
              images: images.map((img) => ({
                data: img.base64,
                mimeType: img.mimeType,
              })),
            });
            const waited = await waitWithOptionalAbort(run.wait(), signal);
            if (waited.status === "error" || waited.status === "cancelled") {
              const code = waited.error?.code ? ` (${waited.error.code})` : "";
              const msg = waited.error?.message || waited.status;
              throw new Error(`${msg}${code}`);
            }
            resultText = String(waited.result || "");
          } finally {
            try {
              await agent[Symbol.asyncDispose]();
            } catch {
              agent.close();
            }
          }
        } else {
          const waited = await waitWithOptionalAbort(
            Agent.prompt(message, agentOpts),
            signal,
          );
          if (waited.status === "error" || waited.status === "cancelled") {
            const code = waited.error?.code ? ` (${waited.error.code})` : "";
            const msg = waited.error?.message || waited.status;
            throw new Error(`${msg}${code}`);
          }
          resultText = String(waited.result || "");
        }

        return parseJsonObject(resultText);
      },
      {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        route: opts.route || "cursor.agent",
        provider: "cursor",
        model: opts.model,
        requestId: opts.requestId,
      },
    );
  } catch (err) {
    throw formatCursorAgentError(err);
  }
}
