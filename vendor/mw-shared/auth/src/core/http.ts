import type { AuthFlowResult } from "./types.js";
import { applySetCookies } from "./cookies.js";

/** Convert an AuthFlowResult into a Web Fetch Response. */
export function toWebResponse(result: AuthFlowResult): Response {
  const headers = new Headers(result.headers ?? {});
  applySetCookies(headers, result.setCookies);
  applySetCookies(headers, result.clearCookies);

  if (result.redirectTo) {
    headers.set("Location", result.redirectTo);
    return new Response(null, { status: result.status || 302, headers });
  }

  if (result.contentType) {
    headers.set("Content-Type", result.contentType);
  }

  return new Response(result.body ?? null, {
    status: result.status,
    headers,
  });
}

export async function readFormOrJson(
  request: Request,
): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const data = (await request.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  }
  if (
    ct.includes("application/x-www-form-urlencoded") ||
    ct.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      out[k] = String(v);
    }
    return out;
  }
  // Keycloak back-channel often posts form-urlencoded without relying on CT alone.
  try {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
