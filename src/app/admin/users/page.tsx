"use client";

import { useCallback, useEffect, useState } from "react";

type AdminUser = {
  id: string;
  name?: string | null;
  email: string;
  role?: string | null;
  plan?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
};

const ROLES = ["user", "admin", "superadmin"] as const;

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (query: string) => {
    setError("");
    const url = query.trim()
      ? `/api/admin/users?q=${encodeURIComponent(query.trim())}`
      : "/api/admin/users";
    const res = await fetch(url, { credentials: "include" });
    const data = (await res.json().catch(() => ({}))) as {
      users?: AdminUser[];
      error?: string;
    };
    if (!res.ok) {
      setError(data.error || "โหลดไม่สำเร็จ");
      setLoading(false);
      return;
    }
    setUsers(Array.isArray(data.users) ? data.users : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => reload(""));
  }, [reload]);

  async function changeRole(user: AdminUser, role: string) {
    setBusyId(user.id);
    setError("");
    setOk("");
    try {
      const res = await fetch("/api/admin/role", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, role }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "เปลี่ยน role ไม่สำเร็จ");
        return;
      }
      setOk(`ตั้ง role ของ ${user.email} เป็น ${role}`);
      await reload(q);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleBan(user: AdminUser) {
    const next = !user.banned;
    const reason = next
      ? window.prompt("เหตุผลในการแบน", user.banReason || "ถูกระงับโดยแอดมิน")
      : null;
    if (next && reason === null) return;
    setBusyId(user.id);
    setError("");
    setOk("");
    try {
      const res = await fetch("/api/admin/ban", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          banned: next,
          banReason: reason || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "อัปเดตแบนไม่สำเร็จ");
        return;
      }
      setOk(next ? `แบน ${user.email} แล้ว` : `ปลดแบน ${user.email} แล้ว`);
      await reload(q);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-panel">
      <form
        className="admin-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setLoading(true);
          void reload(q);
        }}
      >
        <input
          className="admin-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหาอีเมลหรือชื่อ"
          aria-label="ค้นหาผู้ใช้"
        />
        <button type="submit" className="admin-btn">
          ค้นหา
        </button>
      </form>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="auth-ok" role="status">
          {ok}
        </p>
      ) : null}

      {loading ? (
        <p className="admin-muted">กำลังโหลด…</p>
      ) : users.length === 0 ? (
        <p className="admin-muted">ไม่พบผู้ใช้</p>
      ) : (
        <ul className="admin-user-list">
          {users.map((u) => (
            <li key={u.id} className="admin-user-item admin-user-item-stack">
              <div className="admin-user-meta">
                <strong>
                  {u.name || u.email}
                  {u.banned ? (
                    <span className="admin-pill admin-pill-danger">แบน</span>
                  ) : null}
                </strong>
                <span className="auth-bar-muted">
                  {u.email}
                  {` · plan=${u.plan || "free"}`}
                  {u.banReason ? ` · ${u.banReason}` : ""}
                </span>
              </div>
              <div className="admin-user-actions">
                <label className="admin-field-inline">
                  <span>role</span>
                  <select
                    className="admin-select"
                    value={u.role || "user"}
                    disabled={busyId === u.id}
                    onChange={(e) => void changeRole(u, e.target.value)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                    {u.role && !ROLES.includes(u.role as (typeof ROLES)[number]) ? (
                      <option value={u.role}>{u.role}</option>
                    ) : null}
                  </select>
                </label>
                <button
                  type="button"
                  className={`admin-btn ${u.banned ? "" : "admin-btn-danger"}`}
                  disabled={busyId === u.id}
                  onClick={() => void toggleBan(u)}
                >
                  {u.banned ? "ปลดแบน" : "แบน"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
