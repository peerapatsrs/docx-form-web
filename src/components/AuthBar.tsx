"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

export function AuthBar() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void authClient.getSession().then(({ data }) => {
      if (cancelled) return;
      setUser(data?.user ?? null);
      setLoading(false);
    });
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
        <Link className="auth-bar-btn auth-bar-login" href="/login">
          เข้าสู่ระบบ
        </Link>
      </div>
    );
  }

  const label = user.name || user.email || "บัญชี";

  return (
    <div className="auth-bar">
      {user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="auth-bar-avatar" src={user.image} alt="" width={28} height={28} />
      ) : (
        <span className="auth-bar-avatar auth-bar-avatar-fallback" aria-hidden>
          {(label[0] || "?").toUpperCase()}
        </span>
      )}
      <Link className="auth-bar-name" href="/account" title="บัญชีและการตั้งค่าพาสคีย์">
        {label}
      </Link>
      <Link className="auth-bar-btn auth-bar-ghost" href="/account">
        พาสคีย์
      </Link>
      <button
        type="button"
        className="auth-bar-btn auth-bar-ghost"
        onClick={() => {
          void authClient.signOut({
            fetchOptions: {
              onSuccess: () => {
                window.location.href = "/";
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
