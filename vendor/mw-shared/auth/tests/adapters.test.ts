import { describe, expect, it } from "vitest";
import { createTestClient } from "./helpers.js";
import { createNextAuthAdapter } from "../src/adapters/nextjs/index.js";
import {
  createSvelteKitAuthHandle,
  createSvelteKitOidcHandlers,
} from "../src/adapters/sveltekit/index.js";
import { createNodeAuthHandler } from "../src/adapters/node-api/index.js";

describe("adapters", () => {
  it("nextjs adapter exposes handlers and POST-only logout", async () => {
    const { client } = await createTestClient();
    const adapter = createNextAuthAdapter({
      client,
      protectedPathPrefixes: ["/account"],
    });
    expect(adapter.handlers[client.config.paths.logout]).toBeTruthy();
    const get = await adapter.handlers[client.config.paths.logout]!.GET(
      new Request("https://app.test/api/auth/oidc/logout"),
    );
    expect(get.status).toBe(405);

    const proxy = await adapter.handleProxy(
      new Request("https://app.test/", {
        headers: {
          accept: "text/html",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    expect(proxy?.status).toBe(307);
    expect(proxy?.headers.get("location")).toContain(
      client.config.paths.silent,
    );
    expect(proxy?.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sveltekit land + logoutGet 405", async () => {
    const { client } = await createTestClient();
    const handlers = createSvelteKitOidcHandlers(client);
    expect(handlers.logoutGet().status).toBe(405);
    const land = handlers.land(
      new Request("https://app.test/auth/sso/land?next=/packages"),
    );
    expect(land.status).toBe(302);
    expect(land.headers.get("location")).toBe("/packages");
    expect(land.headers.get("referrer-policy")).toBe("no-referrer");

    const handle = createSvelteKitAuthHandle({ client });
    const res = await handle({
      event: {
        request: new Request("https://app.test/", {
          headers: {
            accept: "text/html",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
          },
        }),
        url: new URL("https://app.test/"),
        cookies: { get: () => undefined },
        locals: {},
        fetch,
      },
      resolve: async () => new Response("ok"),
    });
    expect(res.status).toBe(302);
  });

  it("node-api mounts under /api/v1/auth/sso", async () => {
    const { client } = await createTestClient();
    const handler = createNodeAuthHandler({
      client,
      mountPrefix: "/api/v1/auth/sso",
    });
    const login = await handler(
      new Request("https://app.test/api/v1/auth/sso/login"),
    );
    expect(login.status).toBe(302);
    const missing = await handler(new Request("https://app.test/nope"));
    expect(missing.status).toBe(404);
  });

  it("public pages are not forced to login by next proxy", async () => {
    const { client, sessions } = await createTestClient();
    // Active cooldown so silent does not start
    const adapter = createNextAuthAdapter({
      client,
      protectedPathPrefixes: ["/account"],
    });
    await sessions.create({
      sessionId: "x",
      userId: "u",
      sub: "s",
    });
    // No session cookie → public / stays null (but silent may start). Use cooldown via cookie.
    const until = Date.now() + 60_000;
    const res = await adapter.handleProxy(
      new Request("https://app.test/", {
        headers: {
          accept: "text/html",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          cookie: `mw_sso_checked=${until}:0:0`,
        },
      }),
    );
    // Cooldown active, no bypass → no redirect (null = continue)
    expect(res).toBeNull();
  });
});
