"use client";

import { useEffect, useState } from "react";

type AiStatus = {
  byok?: boolean;
  connected?: boolean;
  model?: string;
  models?: { id: string; label: string }[];
  adminDefaultModel?: string | null;
  hasServerEnvKey?: boolean;
  hasServerEnvCursorKey?: boolean;
  effectiveProvider?: string;
  effectiveProviderLabel?: string;
  adminDefaultProvider?: string;
  premiumEnforce?: boolean;
  maskedKey?: string | null;
  configPath?: string;
  studioUrl?: string;
};

export default function AdminAiPage() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [defaultModel, setDefaultModel] = useState("gemini-3.8-flash");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/admin/ai", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: { defaultModel?: string };
        status?: AiStatus;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || "โหลดสถานะ AI ไม่สำเร็จ");
      } else {
        setStatus(data.status || null);
        setDefaultModel(
          data.settings?.defaultModel ||
            data.status?.adminDefaultModel ||
            "gemini-3.8-flash",
        );
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
      const res = await fetch("/api/admin/ai", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: { defaultModel?: string };
        status?: AiStatus;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || "บันทึกไม่สำเร็จ");
        return;
      }
      setStatus(data.status || null);
      if (data.settings?.defaultModel) setDefaultModel(data.settings.defaultModel);
      setOk("บันทึกโมเดลเริ่มต้นแล้ว");
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

  const models = status?.models || [];

  return (
    <div className="admin-overview">
      <section className="admin-panel">
        <h2 className="admin-panel-title">สถานะ AI</h2>
        <ul className="admin-kv">
          <li>
            <span>โหมดคีย์</span>
            <strong>
              {status?.byok
                ? "ใช้คีย์ของผู้ใช้ (เก็บในเบราว์เซอร์/บัญชี)"
                : "เซิร์ฟเวอร์เก็บคีย์ได้"}
            </strong>
          </li>
          <li>
            <span>คีย์ Gemini ของเซิร์ฟเวอร์</span>
            <strong>{status?.hasServerEnvKey ? "ตั้งไว้แล้ว" : "ยังไม่ตั้ง"}</strong>
          </li>
          <li>
            <span>คีย์ Cursor ของเซิร์ฟเวอร์</span>
            <strong>
              {status?.hasServerEnvCursorKey ? "ตั้งไว้แล้ว" : "ยังไม่ตั้ง"}
            </strong>
          </li>
          <li>
            <span>บังคับแผนจ่ายแล้ว</span>
            <strong>{status?.premiumEnforce ? "เปิด" : "ปิด"}</strong>
          </li>
          <li>
            <span>ผู้ให้บริการที่ใช้อยู่</span>
            <strong>
              {status?.effectiveProviderLabel ||
                status?.effectiveProvider ||
                "—"}
            </strong>
          </li>
          <li>
            <span>ค่าเริ่มต้นที่แอดมินตั้ง</span>
            <strong>{status?.adminDefaultProvider || "google"}</strong>
          </li>
          <li>
            <span>โมเดลที่ใช้อยู่</span>
            <strong>{status?.model || "—"}</strong>
          </li>
        </ul>
        {status?.studioUrl ? (
          <p className="admin-muted">
            <a
              className="admin-link"
              href={status.studioUrl}
              target="_blank"
              rel="noreferrer"
            >
              เปิดหน้าสร้างคีย์ Google AI Studio
            </a>
          </p>
        ) : null}
      </section>

      <section className="admin-panel">
        <h2 className="admin-panel-title">โมเดลเริ่มต้น</h2>
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
            <span>โมเดลเริ่มต้น</span>
            <select
              className="admin-select"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!models.some((m) => m.id === defaultModel) ? (
                <option value={defaultModel}>{defaultModel}</option>
              ) : null}
            </select>
          </label>
          <button type="submit" className="admin-btn admin-btn-primary" disabled={busy}>
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </form>
      </section>
    </div>
  );
}
