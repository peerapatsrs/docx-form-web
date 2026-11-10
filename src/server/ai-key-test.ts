/**
 * Minimal live provider probes for "test saved AI key".
 * Never logs key values. Bounded by DOCX_FORM_AI_TIMEOUT_MS (or override).
 */

import { Cursor } from "@cursor/sdk";
import { getAiProvider, getAnthropicApiBase, getGeminiApiBase } from "./ai-providers";
import {
  AiTimeoutError,
  getAiTimeoutMs,
  isAiTimeoutError,
  withAiTimeout,
} from "./ai-request";
import { formatProviderHttpError, isAiCredentialAuthError } from "./ai-http-errors";

export type AiKeyTestResult = {
  ok: boolean;
  code: string;
  message: string;
  provider: string;
  durationMs: number;
};

const TEST_TIMEOUT_CAP_MS = 20_000;

function testTimeoutMs(override?: number): number {
  if (typeof override === "number" && override >= 50) {
    return Math.min(override, TEST_TIMEOUT_CAP_MS);
  }
  return Math.min(getAiTimeoutMs(), TEST_TIMEOUT_CAP_MS);
}

async function testGoogle(
  apiKey: string,
  signal: AbortSignal,
): Promise<void> {
  const url = `${getGeminiApiBase()}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`;
  const res = await fetch(url, { method: "GET", signal });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(formatProviderHttpError("Google AI", res.status, body)),
      { status: res.status },
    );
  }
  // Drain body so the socket can close cleanly.
  await res.arrayBuffer().catch(() => undefined);
}

async function testOpenAiCompat(
  providerId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<void> {
  const provider = getAiProvider(providerId);
  if (!provider?.baseUrl) {
    throw new Error(`ผู้ให้บริการ ${providerId} ไม่รองรับการทดสอบ`);
  }
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(provider.defaultHeaders || {}),
    },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(
        formatProviderHttpError(provider.label, res.status, body || res.statusText),
      ),
      { status: res.status },
    );
  }
  await res.arrayBuffer().catch(() => undefined);
}

async function testAnthropic(apiKey: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${getAnthropicApiBase()}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal,
  });
  const body = await res.text().catch(() => "");
  // 401/403 = bad key; 400/404 model issues often still prove the key was accepted.
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error(formatProviderHttpError("Anthropic", res.status, body)),
      { status: res.status },
    );
  }
  if (!res.ok && res.status !== 400 && res.status !== 404 && res.status !== 429) {
    throw Object.assign(
      new Error(formatProviderHttpError("Anthropic", res.status, body)),
      { status: res.status },
    );
  }
}

async function testCursor(apiKey: string, signal: AbortSignal): Promise<void> {
  // models.list is the lightest authenticated Cursor SDK call.
  const models = await Cursor.models.list({ apiKey });
  if (signal.aborted) throw new AiTimeoutError();
  void models;
}

/**
 * Probe a provider API key. Returns a stable code + Thai message for Frontend.
 * Honours AbortSignal / timeout; never returns or logs the key.
 */
export async function testAiProviderKey(opts: {
  provider: string;
  apiKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AiKeyTestResult> {
  const providerId =
    getAiProvider(opts.provider)?.id || String(opts.provider || "").trim() || "google";
  const provider = getAiProvider(providerId);
  const apiKey = String(opts.apiKey || "").trim();
  const started = Date.now();
  if (!apiKey) {
    return {
      ok: false,
      code: "AI_KEY_INVALID_VALUE",
      message: "ต้องส่งค่าคีย์",
      provider: providerId,
      durationMs: 0,
    };
  }
  if (!provider) {
    return {
      ok: false,
      code: "AI_KEY_INVALID_PROVIDER",
      message: "ผู้ให้บริการไม่รองรับ",
      provider: providerId,
      durationMs: 0,
    };
  }

  // Local mock for CI / VMs without live provider credentials.
  const mock = String(process.env.DOCX_FORM_AI_KEY_TEST_MOCK || "")
    .trim()
    .toLowerCase();
  if (mock === "ok") {
    return {
      ok: true,
      code: "AI_KEY_TEST_OK",
      message: "คีย์ใช้งานได้ (mock)",
      provider: providerId,
      durationMs: Date.now() - started,
    };
  }
  if (mock === "401" || mock === "auth") {
    return {
      ok: false,
      code: "AI_KEY_PROVIDER_AUTH",
      message: `${provider.label}: API key หรือสิทธิ์ไม่ถูกต้อง`,
      provider: providerId,
      durationMs: Date.now() - started,
    };
  }
  if (mock === "hang" || mock === "timeout") {
    try {
      await withAiTimeout(
        (signal) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason || new AiTimeoutError()),
              { once: true },
            );
          }),
        {
          signal: opts.signal,
          timeoutMs: testTimeoutMs(opts.timeoutMs ?? 120),
          route: "ai.keys.test",
          provider: providerId,
        },
      );
    } catch (err) {
      return {
        ok: false,
        code: "AI_KEY_TEST_TIMEOUT",
        message: isAiTimeoutError(err)
          ? err instanceof Error
            ? err.message
            : "AI_TIMEOUT"
          : "หมดเวลาทดสอบคีย์",
        provider: providerId,
        durationMs: Date.now() - started,
      };
    }
  }

  try {
    await withAiTimeout(
      async (signal) => {
        if (provider.apiFamily === "gemini") {
          await testGoogle(apiKey, signal);
        } else if (provider.apiFamily === "cursor") {
          await testCursor(apiKey, signal);
        } else if (provider.apiFamily === "anthropic") {
          await testAnthropic(apiKey, signal);
        } else if (provider.apiFamily === "openai") {
          await testOpenAiCompat(providerId, apiKey, signal);
        } else {
          throw new Error(`ยังไม่รองรับการทดสอบผู้ให้บริการ ${providerId}`);
        }
      },
      {
        signal: opts.signal,
        timeoutMs: testTimeoutMs(opts.timeoutMs),
        route: "ai.keys.test",
        provider: providerId,
      },
    );
    return {
      ok: true,
      code: "AI_KEY_TEST_OK",
      message: "คีย์ใช้งานได้",
      provider: providerId,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    if (isAiTimeoutError(err)) {
      return {
        ok: false,
        code: "AI_KEY_TEST_TIMEOUT",
        message:
          err instanceof Error
            ? err.message
            : "หมดเวลาทดสอบคีย์ — ลองใหม่ภายหลัง",
        provider: providerId,
        durationMs,
      };
    }
    const message =
      err instanceof Error ? err.message : String(err || "ทดสอบคีย์ไม่สำเร็จ");
    if (isAiCredentialAuthError(err)) {
      return {
        ok: false,
        code: "AI_KEY_PROVIDER_AUTH",
        message,
        provider: providerId,
        durationMs,
      };
    }
    return {
      ok: false,
      code: "AI_KEY_PROVIDER_ERROR",
      message,
      provider: providerId,
      durationMs,
    };
  }
}
