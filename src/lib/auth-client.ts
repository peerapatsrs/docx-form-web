"use client";

import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient } from "better-auth/client/plugins";
import { ac, roles } from "@/lib/auth-permissions";

export const authClient = createAuthClient({
  plugins: [
    passkeyClient(),
    adminClient({
      ac,
      roles,
    }),
  ],
});
