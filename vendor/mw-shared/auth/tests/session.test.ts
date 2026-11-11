import { describe, expect, it } from "vitest";
import { validateSession } from "../src/core/session.js";
import { MemorySessionStore } from "../src/core/memory-stores.js";

describe("validateSession fail-safe", () => {
  it("no cookie → no session", async () => {
    const store = new MemorySessionStore();
    const r = await validateSession({
      sessionId: null,
      store,
      sessionCookieName: "mw_session",
    });
    expect(r.hasSession).toBe(false);
    expect(r.clearCookies).toEqual([]);
  });

  it("definitive miss clears cookie", async () => {
    const store = new MemorySessionStore();
    const r = await validateSession({
      sessionId: "missing",
      store,
      sessionCookieName: "mw_session",
      secureCookies: true,
    });
    expect(r.hasSession).toBe(false);
    expect(r.clearCookies[0]?.name).toBe("mw_session");
    expect(r.clearCookies[0]?.attributes.maxAge).toBe(0);
  });

  it("store throw keeps session (fail-safe)", async () => {
    const store = {
      async create() {
        throw new Error("nope");
      },
      async get() {
        throw new Error("db down");
      },
      async delete() {},
      async findBySid() {
        return [];
      },
      async findBySub() {
        return [];
      },
    };
    const r = await validateSession({
      sessionId: "alive",
      store,
      sessionCookieName: "mw_session",
    });
    expect(r.hasSession).toBe(true);
    expect(r.storeError).toBe(true);
    expect(r.clearCookies).toEqual([]);
  });

  it("valid session returns record", async () => {
    const store = new MemorySessionStore();
    await store.create({
      sessionId: "s1",
      userId: "u1",
      sub: "sub-1",
      sid: "sid-1",
    });
    const r = await validateSession({
      sessionId: "s1",
      store,
      sessionCookieName: "mw_session",
    });
    expect(r.hasSession).toBe(true);
    expect(r.session?.sub).toBe("sub-1");
    expect(r.session?.sid).toBe("sid-1");
  });
});
