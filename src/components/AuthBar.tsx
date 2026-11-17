"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

/** Playwright / local header verify only — never set in production flows. */
function readVerifySessionUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  try {
    const w = window as Window & {
      __DOCX_FORM_VERIFY_SESSION__?: { user?: SessionUser | null };
    };
    const user = w.__DOCX_FORM_VERIFY_SESSION__?.user;
    return user ?? null;
  } catch {
    return null;
  }
}

function displayName(user: SessionUser): string {
  return user.name || user.email || "บัญชี";
}

function LogoutButton({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <form
      method="POST"
      action={SSO_LOGOUT_PATH}
      className="auth-bar-logout-form"
      onSubmit={(e) => {
        if (
          !window.confirm(
            "ออกจากระบบ?\nจะออกจากบัญชีนี้บนเครื่องนี้และที่ Keycloak",
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      {/* Top-level document POST — required so the browser follows 303 to end_session. */}
      <button type="submit" className={className}>
        {children}
      </button>
    </form>
  );
}

export function AuthBar() {
  const pathname = usePathname() || "/";
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const loginHref = `/login?next=${encodeURIComponent(
    pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/",
  )}`;

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const verifyUser = readVerifySessionUser();
        if (verifyUser) {
          if (!cancelled) setUser(verifyUser);
          return;
        }
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

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    const onPointer = (e: MouseEvent | PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) closeMenu();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menuOpen, closeMenu]);

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

  const name = displayName(user);
  const plan = planBadgeLabel(user);
  const admin = isSuperAdmin(user);

  return (
    <div className="auth-bar" ref={rootRef} data-auth-bar="signed-in">
      {/* Desktop (≥1024px): unchanged inline cluster */}
      <div className="auth-bar-desktop">
        <Link
          className="auth-bar-user"
          href="/account"
          title={user.email || ""}
        >
          <ProfileAvatar
            name={user.name}
            email={user.email}
            image={user.image}
            size={28}
          />
          <span className="auth-bar-name">{name}</span>
          <span className="auth-bar-plan">{plan}</span>
        </Link>
        {admin ? (
          <Link className="auth-bar-btn auth-bar-ghost" href="/admin">
            Admin
          </Link>
        ) : null}
        <LogoutButton className="auth-bar-btn auth-bar-ghost">
          ออกจากระบบ
        </LogoutButton>
      </div>

      {/* Small screens: avatar opens accessible account menu */}
      <div className="auth-bar-mobile">
        <button
          type="button"
          className="auth-bar-avatar-btn"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-controls={menuId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <ProfileAvatar
            name={user.name}
            email={user.email}
            image={user.image}
            size={36}
          />
          <span className="sr-only">เมนูบัญชี</span>
        </button>
        {menuOpen ? (
          <div
            id={menuId}
            className="auth-bar-menu"
            role="menu"
            aria-label="เมนูบัญชี"
          >
            <Link
              role="menuitem"
              className="auth-bar-menu-item auth-bar-menu-profile"
              href="/account"
              title={user.email || ""}
              onClick={closeMenu}
            >
              <span className="auth-bar-name">{name}</span>
              <span className={`auth-bar-plan${isPaidSessionUser(user) ? " is-pro" : ""}`}>
                {plan}
              </span>
            </Link>
            {admin ? (
              <Link
                role="menuitem"
                className="auth-bar-menu-item"
                href="/admin"
                onClick={closeMenu}
              >
                Admin
              </Link>
            ) : null}
            <LogoutButton className="auth-bar-menu-item auth-bar-menu-logout">
              ออกจากระบบ
            </LogoutButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}
