"use client";

/**
 * Development-only auth UI helpers. This module is only imported when
 * NEXT_PUBLIC_DEV_AUTH (or non-production NODE_ENV) includes it in the bundle.
 */

export type DevUser = {
  id: string;
  name?: string | null;
  email: string;
  role?: string;
  plan?: string;
  banned?: boolean;
};

export async function fetchDevAuthConfig(): Promise<{
  enabled: boolean;
  defaultEmail: string | null;
}> {
  const cfg = (await fetch("/api/auth-config")
    .then((r) => r.json())
    .catch(() => null)) as {
    devAuth?: boolean;
    devAuthDefaultEmail?: string | null;
  } | null;
  return {
    enabled: Boolean(cfg?.devAuth),
    defaultEmail: cfg?.devAuthDefaultEmail
      ? String(cfg.devAuthDefaultEmail).trim().toLowerCase()
      : null,
  };
}

export async function listDevUsers(): Promise<DevUser[]> {
  const body = (await fetch("/api/auth/dev/users", { credentials: "include" })
    .then((r) => r.json())
    .catch(() => ({}))) as { users?: DevUser[] };
  return Array.isArray(body.users) ? body.users : [];
}

export async function loginAsDevUser(input: {
  userId?: string;
  email?: string;
}): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch("/api/auth/dev/login-as", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    message?: string;
    error?: string | { message?: string };
  };
  if (!res.ok || !data.ok) {
    const msg =
      (typeof data.error === "object" && data.error?.message) ||
      data.message ||
      data.error ||
      "เลือก user ไม่สำเร็จ";
    return { ok: false, message: String(msg) };
  }
  return { ok: true };
}

export function DevUserPicker(props: {
  users: DevUser[];
  busy: string | null;
  onPick: (user: DevUser) => void;
}) {
  const { users, busy, onPick } = props;
  return (
    <section className="dev-user-panel" aria-label="Dev user picker">
      <p className="auth-section-title">Dev — เลือก user (ไม่ต้อง OAuth)</p>
      <p className="auth-hint">ใช้เฉพาะสภาพแวดล้อมพัฒนา / Docker local</p>
      {users.length === 0 ? (
        <p className="auth-hint">
          ยังไม่มี user ในฐานข้อมูล — ล็อกอิน OAuth จริงครั้งหนึ่งก่อน
        </p>
      ) : (
        <ul className="dev-user-list">
          {users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="dev-user-btn"
                disabled={busy !== null || Boolean(u.banned)}
                onClick={() => onPick(u)}
              >
                <span className="dev-user-main">
                  <strong>{u.name || u.email}</strong>
                  <span>
                    {u.email}
                    {u.banned ? " · แบน" : ""}
                  </span>
                </span>
                <span className="dev-user-meta">
                  {u.role || "user"} · {u.plan || "free"}
                  {busy === `dev-${u.id}` ? "…" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
