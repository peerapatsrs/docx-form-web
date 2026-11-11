/**
 * Workerd / Web-standards compatibility: exercise core helpers that must not
 * touch Node-only APIs. Miniflare is used when available; otherwise the same
 * assertions run in the Vitest node environment as a smoke check that the
 * modules import cleanly under Web Crypto.
 */
import { describe, expect, it } from "vitest";
import { pkceChallengeS256, createOidcAuthRequestSecrets } from "../../src/core/pkce.js";
import { safeReturnTo, stripSsoBypassParam } from "../../src/core/safe-return.js";
import {
  serializeCooldownValue,
  parseCooldownCookie,
  isTopLevelDocumentNavigation,
} from "../../src/core/silent-sso.js";
import { generateRandomBase64Url } from "../../src/core/crypto.js";

async function maybeRunInMiniflare(
  script: string,
): Promise<{ ok: boolean; skipped?: boolean; detail?: string }> {
  try {
    const { Miniflare } = await import("miniflare");
    const mf = new Miniflare({
      modules: true,
      script,
      compatibilityDate: "2024-09-23",
    });
    const res = await mf.dispatchFetch("http://localhost/");
    const text = await res.text();
    await mf.dispose();
    return { ok: res.status === 200 && text === "ok", detail: text };
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("workerd-compatible core", () => {
  it("Web Crypto PKCE + cooldown + safeReturn (local)", async () => {
    expect(typeof crypto.subtle.digest).toBe("function");
    const challenge = await pkceChallengeS256("workerd-verifier");
    expect(challenge.length).toBeGreaterThan(20);
    const secrets = await createOidcAuthRequestSecrets();
    expect(secrets.codeChallenge).toBeTruthy();
    expect(generateRandomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(safeReturnTo("//evil", "/", "https://app.test")).toBe("/");
    expect(stripSsoBypassParam("/x?sso=1")).toBe("/x");

    const raw = serializeCooldownValue({
      until: Date.now() + 1000,
      pending: false,
      bypassUsed: true,
    });
    expect(parseCooldownCookie(raw)?.bypassUsed).toBe(true);

    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "document",
        secFetchMode: "navigate",
        accept: "text/html",
        pathname: "/",
      }),
    ).toBe(true);
  });

  it("runs a tiny worker via miniflare when available", async () => {
    const result = await maybeRunInMiniflare(`
      export default {
        async fetch() {
          const buf = new Uint8Array(16);
          crypto.getRandomValues(buf);
          const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"));
          if (!(dig instanceof ArrayBuffer) || dig.byteLength !== 32) {
            return new Response("bad", { status: 500 });
          }
          return new Response("ok");
        }
      }
    `);
    if (result.skipped) {
      // Miniflare optional in constrained CI images — local Web Crypto test above is required.
      expect(result.skipped).toBe(true);
      return;
    }
    expect(result.ok).toBe(true);
  });
});
