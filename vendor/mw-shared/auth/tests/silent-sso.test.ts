import { describe, expect, it } from "vitest";
import {
  parseCooldownCookie,
  serializeCooldownValue,
  canUseSilentSsoBypass,
  isCooldownActive,
  isTopLevelDocumentNavigation,
  resolveSilentSsoStart,
  normalizeSilentOutcome,
  buildCooldownState,
} from "../src/core/silent-sso.js";

describe("cooldown cookie until:pending:bypassUsed", () => {
  it("round-trips", () => {
    const until = Date.now() + 60_000;
    const value = serializeCooldownValue({
      until,
      pending: true,
      bypassUsed: false,
    });
    expect(value).toBe(`${until}:1:0`);
    expect(parseCooldownCookie(value)).toEqual({
      until,
      pending: true,
      bypassUsed: false,
    });
  });

  it("bypass rules", () => {
    const now = 1_700_000_000_000;
    expect(canUseSilentSsoBypass(null, now)).toBe(true);

    const pending = serializeCooldownValue({
      until: now + 60_000,
      pending: true,
      bypassUsed: false,
    });
    expect(canUseSilentSsoBypass(pending, now)).toBe(false);

    const used = serializeCooldownValue({
      until: now + 60_000,
      pending: false,
      bypassUsed: true,
    });
    expect(canUseSilentSsoBypass(used, now)).toBe(false);

    const normalFail = serializeCooldownValue({
      until: now + 60_000,
      pending: false,
      bypassUsed: false,
    });
    expect(canUseSilentSsoBypass(normalFail, now)).toBe(true);
    expect(isCooldownActive(normalFail, now)).toBe(true);
    expect(isCooldownActive(normalFail, now + 61_000)).toBe(false);
  });

  it("buildCooldownState preserves until inside window", () => {
    const now = 1000;
    const previous = { until: 5000, pending: true, bypassUsed: false };
    const next = buildCooldownState({
      nowMs: now,
      cooldownSec: 60,
      pending: false,
      bypassUsed: true,
      previous,
    });
    expect(next.until).toBe(5000);
    expect(next.pending).toBe(false);
    expect(next.bypassUsed).toBe(true);
  });
});

describe("isTopLevelDocumentNavigation", () => {
  it("requires document + navigate when Sec-Fetch present", () => {
    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "document",
        secFetchMode: "navigate",
        accept: "text/html",
        pathname: "/",
      }),
    ).toBe(true);

    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "empty",
        secFetchMode: "cors",
        accept: "*/*",
        pathname: "/",
      }),
    ).toBe(false);

    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "iframe",
        secFetchMode: "navigate",
        accept: "text/html",
        pathname: "/",
      }),
    ).toBe(false);
  });

  it("rejects RSC / prefetch / non-html", () => {
    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "document",
        secFetchMode: "navigate",
        rscHeader: "1",
        pathname: "/",
      }),
    ).toBe(false);
    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "document",
        secFetchMode: "navigate",
        nextRouterPrefetch: "1",
        pathname: "/",
      }),
    ).toBe(false);
    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "document",
        secFetchMode: "navigate",
        purpose: "prefetch",
        pathname: "/",
      }),
    ).toBe(false);
    expect(
      isTopLevelDocumentNavigation({
        secFetchDest: "document",
        secFetchMode: "navigate",
        accept: "application/json",
        pathname: "/",
      }),
    ).toBe(false);
  });
});

describe("resolveSilentSsoStart", () => {
  const base = {
    pathname: "/",
    search: "",
    hasSession: false,
    oidcEnabled: true,
    isDocumentNavigation: true,
    hubOrigins: ["https://hub.test"],
    nowMs: 1_000_000,
    cooldownSec: 60,
  };

  it("starts normally when no cooldown", () => {
    expect(resolveSilentSsoStart(base)).toEqual({
      start: true,
      viaBypass: false,
    });
  });

  it("allows hub/?sso=1 bypass once after normal fail", () => {
    const cookie = serializeCooldownValue({
      until: base.nowMs + 60_000,
      pending: false,
      bypassUsed: false,
    });
    expect(
      resolveSilentSsoStart({
        ...base,
        cooldownCookie: cookie,
        referer: "https://hub.test/app",
      }),
    ).toEqual({ start: true, viaBypass: true });

    expect(
      resolveSilentSsoStart({
        ...base,
        cooldownCookie: cookie,
        search: "?sso=1",
      }),
    ).toEqual({ start: true, viaBypass: true });
  });

  it("refuses second bypass and strips sso", () => {
    const cookie = serializeCooldownValue({
      until: base.nowMs + 60_000,
      pending: false,
      bypassUsed: true,
    });
    expect(
      resolveSilentSsoStart({
        ...base,
        cooldownCookie: cookie,
        search: "?sso=1&x=1",
      }),
    ).toEqual({ start: false, viaBypass: false, stripSsoParam: true });
  });

  it("never starts without document navigation or with session", () => {
    expect(
      resolveSilentSsoStart({ ...base, isDocumentNavigation: false }),
    ).toEqual({ start: false, viaBypass: false });
    expect(resolveSilentSsoStart({ ...base, hasSession: true })).toEqual({
      start: false,
      viaBypass: false,
      stripSsoParam: false,
    });
  });
});

describe("normalizeSilentOutcome", () => {
  it("maps quiet IdP errors", () => {
    expect(normalizeSilentOutcome("login_required")).toBe("login_required");
    expect(normalizeSilentOutcome("interaction_required")).toBe(
      "login_required",
    );
    expect(normalizeSilentOutcome("consent_required")).toBe("login_required");
    expect(normalizeSilentOutcome("server_error")).toBe("fail");
  });
});
