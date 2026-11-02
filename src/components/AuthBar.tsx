"use client";

import Link from "next/link";
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

export function AuthBar() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await authClient.getSession();
        if (cancelled) return;
        if (data?.user) {
          setUser(data.user);
          setLoading(false);
          return;
        }

        // Dev-only auto sign-in. Condition uses build-time env so production
        // bundles (without NEXT_PUBLIC_DEV_AUTH) drop this import entirely.
        if (
          process.env.NODE_ENV !== "production" ||
          process.env.NEXT_PUBLIC_DEV_AUTH === "1"
        ) {
          const { fetchDevAuthConfig, loginAsDevUser } = await import(
            "@/components/DevAuthControls"
          );
          const cfg = await fetchDevAuthConfig();
          const email = cfg.defaultEmail;
          if (!cfg.enabled || !email) {
            setLoading(false);
            return;
          }
          const result = await loginAsDevUser({ email });
          if (cancelled) return;
          if (result.ok) {
            const again = await authClient.getSession();
            if (cancelled) return;
            setUser(again.data?.user ?? null);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="auth-bar auth-bar-loading" aria-busy="true">
        <span className="auth-bar-muted">…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-bar">
        {/* Hard nav — soft Link ↔ /login breaks the app.js home shell for guests */}
        <a className="auth-bar-btn auth-bar-login" href="/login">
          เข้าสู่ระบบ
        </a>
      </div>
    );
  }

  const label = user.name || user.email || "บัญชี";
  const paid = isPaidSessionUser(user);
  const planLabel = planBadgeLabel(user);

  return (
    <div className="auth-bar">
      <ProfileAvatar
        image={user.image}
        name={user.name}
        email={user.email}
        size={28}
      />
      <Link className="auth-bar-name" href="/account" title="บัญชี · พาสคีย์ · แผน">
        {label}
      </Link>
      <Link
        className={`auth-bar-plan ${paid ? "is-pro" : ""}`}
        href="/account"
        title={paid ? "แผนจ่ายแล้ว — ดูโควตาที่บัญชี" : "แผนฟรี — ดูโควตาที่บัญชี"}
      >
        {planLabel}
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
          void authClient.signOut({
            fetchOptions: {
              onSuccess: () => {
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard nav after sign-out
                window.location.assign("/");
              },
            },
          });
        }}
      >
        ออก
      </button>
    </div>
  );
}
