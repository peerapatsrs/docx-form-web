import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { requireSuperAdmin } from "@/server/premium";

export type ServerSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

/** Live Better Auth session for the current RSC/request (DB-backed). */
export async function getServerSession(): Promise<ServerSession | null> {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  return session ?? null;
}

function loginRedirect(nextPath: string): never {
  const next = encodeURIComponent(nextPath || "/");
  redirect(`/login?next=${next}`);
}

/**
 * Hard gate for logged-in pages (/account, …).
 * Redirects unauthenticated direct URL hits to /login.
 */
export async function requireServerUser(
  nextPath = "/account",
): Promise<ServerSession> {
  const session = await getServerSession();
  if (!session?.user) loginRedirect(nextPath);
  return session;
}

/**
 * Hard gate for /admin/* — session + superadmin role from DB.
 * Unauthenticated → /login · authenticated without role → home.
 */
export async function requireServerSuperAdmin(
  nextPath = "/admin",
): Promise<ServerSession> {
  const session = await requireServerUser(nextPath);
  const h = await headers();
  const gate = await requireSuperAdmin(
    new Request("http://docx-form.local/admin-gate", { headers: h }),
  );
  if (!gate.ok) {
    if (gate.status === 401) loginRedirect(nextPath);
    redirect("/");
  }
  return session;
}

/** If already signed in, skip the login page. */
export async function redirectIfAuthenticated(to = "/"): Promise<void> {
  const session = await getServerSession();
  if (session?.user) redirect(to);
}
