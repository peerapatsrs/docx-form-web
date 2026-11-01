"use client";

import { useCallback, useEffect, useState } from "react";

type AdminUser = {
  id: string;
  name?: string | null;
  email: string;
  role?: string | null;
  plan?: string | null;
  createdAt?: string | Date;
};

function isSuperAdminRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return String(role)
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .includes("superadmin");
}

function isPaidPlan(plan: string | null | undefined, role?: string | null): boolean {
  const p = String(plan || "")
    .trim()
    .toLowerCase();
  if (p === "pro" || p === "paid" || p === "premium") return true;
  return isSuperAdminRole(role) || String(role || "").toLowerCase().includes("admin");
}

export default function AdminBillingPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [limits, setLimits] = useState<{ freeMaxMulti: number; paidMaxMulti: number }>({
    freeMaxMulti: 2,
    paidMaxMulti: 10,
  });

  const reload = useCallback(async () => {
    setError("");
    const [usersRes, limitsRes] = await Promise.all([
      fetch("/api/admin/users", { credentials: "include" }),
      fetch("/api/admin/limits", { credentials: "include" }),
    ]);
    const data = (await usersRes.json().catch(() => ({}))) as {
      users?: AdminUser[];
      error?: string;
    };
    const limitsData = (await limitsRes.json().catch(() => ({}))) as {
      limits?: { freeMaxMulti?: number; paidMaxMulti?: number };
    };
    if (limitsRes.ok && limitsData.limits) {
      setLimits({
        freeMaxMulti: Number(limitsData.limits.freeMaxMulti) || 2,
        paidMaxMulti: Number(limitsData.limits.paidMaxMulti) || 10,
      });
    }
    if (!usersRes.ok) {
      setError(data.error || "โหลดรายชื่อไม่สำเร็จ");
      setLoading(false);
      return;
    }
    setUsers(Array.isArray(data.users) ? data.users : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => reload());
  }, [reload]);

  async function setPaid(user: AdminUser, paid: boolean) {
    setBusyId(user.id);
    setError("");
    setOk("");
    try {
      const res = await fetch("/api/admin/plan", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          plan: paid ? "pro" : "free",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        user?: { email?: string; plan?: string };
      };
      if (!res.ok) {
        setError(data.error || "อัปเดตไม่สำเร็จ");
        return;
      }
      const email = data.user?.email || user.email;
      const plan = data.user?.plan || (paid ? "pro" : "free");
      setOk(
        plan === "pro"
          ? `ตั้ง ${email} เป็นจ่ายแล้ว (pro) แล้วในฐานข้อมูล`
          : `ถอดสถานะจ่ายแล้วของ ${email} แล้ว`,
      );
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <section className="admin-panel">
        <p className="admin-muted">กำลังโหลดผู้ใช้…</p>
      </section>
    );
  }

  return (
    <section className="admin-panel">
      <p className="admin-muted">
        ฟรี ≤ {limits.freeMaxMulti} ไฟล์ต่อครั้ง · จ่ายแล้ว ≤ {limits.paidMaxMulti} ·
        role admin/superadmin นับเป็นจ่ายแล้วอัตโนมัติ
      </p>

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

      {users.length === 0 ? (
        <p className="admin-muted">ยังไม่มีผู้ใช้ในระบบ</p>
      ) : (
        <ul className="admin-user-list">
          {users.map((u) => {
            const paid = isPaidPlan(u.plan, u.role);
            const staff = isSuperAdminRole(u.role);
            const locked = staff;
            return (
              <li key={u.id} className="admin-user-item">
                <div className="admin-user-meta">
                  <strong>{u.name || u.email}</strong>
                  <span className="auth-bar-muted">
                    {u.email}
                    {u.role ? ` · ${u.role}` : ""}
                    {` · plan=${u.plan || "free"}`}
                  </span>
                </div>
                <label className="admin-paid-toggle">
                  <input
                    type="checkbox"
                    checked={paid}
                    disabled={locked || busyId === u.id}
                    onChange={(e) => void setPaid(u, e.target.checked)}
                  />
                  <span>{locked ? "staff (จ่ายแล้ว)" : "จ่ายแล้ว"}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
