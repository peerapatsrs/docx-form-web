"use client";

import { useCallback, useEffect, useState } from "react";

type AuditRow = {
  id: number;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetId: string | null;
  targetEmail: string | null;
  detail: unknown;
  createdAt: string | Date;
};

function fmtTime(v: string | Date) {
  try {
    return new Date(v).toLocaleString("th-TH");
  } catch {
    return String(v);
  }
}

function fmtDetail(detail: unknown) {
  if (detail == null) return "—";
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export default function AdminAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setError("");
    const res = await fetch("/api/admin/audit?limit=150", {
      credentials: "include",
    });
    const data = (await res.json().catch(() => ({}))) as {
      rows?: AuditRow[];
      error?: string;
    };
    if (!res.ok) {
      setError(data.error || "โหลดบันทึกไม่สำเร็จ");
      setLoading(false);
      return;
    }
    setRows(Array.isArray(data.rows) ? data.rows : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => reload());
  }, [reload]);

  return (
    <section className="admin-panel">
      <div className="admin-toolbar">
        <p className="admin-muted" style={{ margin: 0 }}>
          การกระทำของแอดมิน (แผน / role / แบน / ลิมิต / AI)
        </p>
        <button
          type="button"
          className="admin-btn"
          onClick={() => {
            setLoading(true);
            void reload();
          }}
        >
          รีเฟรช
        </button>
      </div>
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="admin-muted">กำลังโหลด…</p>
      ) : rows.length === 0 ? (
        <p className="admin-muted">ยังไม่มีบันทึก — เมื่อมีการแก้ที่ Admin จะโผล่ที่นี่</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>เวลา</th>
                <th>ผู้ทำ</th>
                <th>action</th>
                <th>เป้าหมาย</th>
                <th>รายละเอียด</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmtTime(r.createdAt)}</td>
                  <td>{r.actorEmail || r.actorId || "—"}</td>
                  <td>
                    <code>{r.action}</code>
                  </td>
                  <td>{r.targetEmail || r.targetId || "—"}</td>
                  <td className="admin-table-detail">{fmtDetail(r.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
