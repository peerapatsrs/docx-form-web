import { createAuthClient } from "../src/core/client.js";
import {
  MemorySessionStore,
  MemoryStateStore,
  MemoryUserResolver,
} from "../src/core/memory-stores.js";
import { createMockOidcIdp } from "../src/testing/mock-idp.js";
import { clearOidcDiscoveryCache } from "../src/core/discovery.js";
import type { MwAuthConfig } from "../src/core/types.js";

export async function createTestClient(
  overrides: Partial<MwAuthConfig> = {},
  hooks: {
    onSilentLoginSuccess?: Parameters<
      typeof createAuthClient
    >[0]["deps"]["onSilentLoginSuccess"];
  } = {},
) {
  clearOidcDiscoveryCache();
  const issuer = "https://idp.test/realms/dev";
  const clientId = "test-client";
  const idp = await createMockOidcIdp({ issuer, clientId });
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  const users = new MemoryUserResolver();

  const client = createAuthClient({
    config: {
      issuer,
      clientId,
      clientSecret: "test-secret",
      publicOrigin: "https://app.test",
      hubOrigins: ["https://hub.test"],
      cooldownSec: 60,
      secureCookies: true,
      ...overrides,
    },
    deps: {
      sessions,
      state,
      users,
      fetch: idp.fetch,
      now: () => Date.now(),
      onSilentLoginSuccess: hooks.onSilentLoginSuccess,
    },
  });

  return { client, idp, sessions, state, users };
}
