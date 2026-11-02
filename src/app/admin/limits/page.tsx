"use client";

import { useEffect, useState } from "react";

type Limits = { freeMaxMulti: number; paidMaxMulti: number };

export default function AdminLimitsPage() {
  const [limits, setLimits] = useState<Limits>({ freeMaxMulti: 2, paidMaxMulti: 10 });
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/admin/limits", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        limits?: Limits;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || "โหลดลิมิตไม่สำเร็จ");
      } else if (data.limits) {
        setLimits(data.limits);
      }
      setLoading(false);
    })();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await fetch("/api/admin/limits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(limits),
      });
      const data = (await res.json().catch(() => ({}))) as {
        limits?: Limits;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || "บันทึกไม่สำเร็จ");
        return;
      }
      if (data.limits) setLimits(data.limits);
      setOk("บันทึกลิมิตแล้ว — มีผลกับ /api/entitlement ทันที");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="admin-panel">
        <p className="admin-muted">กำลังโหลด…</p>
      </section>
    );
  }

  return (
    <section className="admin-panel">
      <p className="admin-muted">
        จำนวนเทมเพลตสูงสุดต่อครั้งเมื่อทำงานหลายไฟล์ (1–50) · จ่ายแล้วต้องไม่ต่ำกว่าฟรี
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
      <form className="admin-form" onSubmit={(e) => void save(e)}>
        <label className="admin-field">
          <span>ฟรี (freeMaxMulti)</span>
          <input
            className="admin-input"
            type="number"
            min={1}
            max={50}
            value={limits.freeMaxMulti}
            onChange={(e) =>
              setLimits((s) => ({
                ...s,
                freeMaxMulti: Number(e.target.value),
              }))
            }
          />
        </label>
        <label className="admin-field">
          <span>จ่ายแล้ว (paidMaxMulti)</span>
          <input
            className="admin-input"
            type="number"
            min={1}
            max={50}
            value={limits.paidMaxMulti}
            onChange={(e) =>
              setLimits((s) => ({
                ...s,
                paidMaxMulti: Number(e.target.value),
              }))
            }
          />
        </label>
        <button type="submit" className="admin-btn admin-btn-primary" disabled={busy}>
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </form>
    </section>
  );
}
