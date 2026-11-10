"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { ProfileAvatar } from "@/components/ProfileAvatar";

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string | null;
  plan?: string | null;
};

function roleParts(role: string | null | undefined): string[] {
  return String(role || "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

function isSuperAdmin(user: SessionUser | null): boolean {
  return roleParts(user?.role).includes("superadmin");
}

function isPaidSessionUser(user: SessionUser | null): boolean {
  if (!user) return false;
  const plan = String(user.plan || "")
    .trim()
    .toLowerCase();
  if (plan === "pro" || plan === "paid" || plan === "premium") return true;
  const roles = roleParts(user.role);
  return roles.some((r) => r === "admin" || r === "superadmin");
}

function planBadgeLabel(user: SessionUser | null): string {
  return isPaidSessionUser(user) ? "จ่ายแล้ว" : "ฟรี";
}

const SSO_LOGOUT_PATH = "/api/auth/oidc/logout";

export function AuthBar() {
  const pathname = usePathname() || "/";
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const loginHref = `/login?next=${encodeURIComponent(
    pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/",
  )}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await authClient.getSession();
        if (cancelled) return;
        setUser(data?.user ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="auth-bar auth-bar-loading" aria-hidden="true" />;
  }

  if (!user) {
    return (
      <div className="auth-bar">
        <Link className="auth-bar-btn auth-bar-primary" href={loginHref}>
          เข้าสู่ระบบ
        </Link>
      </div>
    );
  }

  return (
    <div className="auth-bar">
      <Link className="auth-bar-user" href="/account" title={user.email || ""}>
        <ProfileAvatar
          name={user.name}
          email={user.email}
          image={user.image}
          size={28}
        />
        <span className="auth-bar-name">{user.name || user.email || "บัญชี"}</span>
        <span className="auth-bar-plan">{planBadgeLabel(user)}</span>
      </Link>
      {isSuperAdmin(user) ? (
        <Link className="auth-bar-btn auth-bar-ghost" href="/admin">
          Admin
        </Link>
      ) : null}
      <button
        type="button"
        className="auth-bar-btn auth-bar-ghost"
        onClick={() => {
          if (
            !window.confirm(
              "ออกจากระบบ?\nจะออกจากบัญชีนี้บนเครื่องนี้และที่ Keycloak",
            )
          ) {
            return;
          }
          // Always RP-initiated OIDC logout (clears app session + IdP).
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard nav to logout
          window.location.assign(SSO_LOGOUT_PATH);
        }}
      >
        ออกจากระบบ
      </button>
    </div>
  );
}
