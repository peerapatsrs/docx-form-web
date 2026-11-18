"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { ac, roles } from "@/lib/auth-permissions";

/** Session / admin client only — login is Keycloak OIDC (no passkey/social). */
export const authClient = createAuthClient({
  plugins: [
    adminClient({
      ac,
      roles,
    }),
  ],
});
