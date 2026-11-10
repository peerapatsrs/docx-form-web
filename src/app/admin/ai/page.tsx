"use client";

import { useEffect, useState } from "react";

type AiStatus = {
  byok?: boolean;
  connected?: boolean;
  model?: string;
  effectiveModel?: string;
  models?: { id: string; label: string }[];
  adminDefaultModel?: string | null;
  hasServerEnvKey?: boolean;
  hasServerEnvCursorKey?: boolean;
  hasServerFileGeminiKey?: boolean;
  serverEnvCursorKeySource?: string | null;
  serverEnvGeminiKeySource?: string | null;
  effectiveProvider?: string;
  effectiveProviderLabel?: string;
  adminDefaultProvider?: string;
  defaultModel?: string;
  premiumEnforce?: boolean;
  premiumEnforceLabel?: string;
  maskedKey?: string | null;
  configStoreLabel?: string;
  studioUrl?: string;
  keySource?: "user" | "shared" | "none";
};

export default function AdminAiPage() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [defaultModel, setDefaultModel] = useState("gemini-3.8-flash");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
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
  }

  useEffect(() => {
    void (async () => {
      await load();
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

  async function clearServerFileKey() {
    if (
      !window.confirm(
        "ลบคีย์ Gemini ที่เก็บบนเซิร์ฟเวอร์ (ไฟล์)? คีย์จากเซิร์ฟเวอร์จะไม่ถูกลบถ้าตั้งผ่านระบบ",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await fetch("/api/admin/ai/server-key", {
        method: "DELETE",
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: AiStatus;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || "ลบคีย์ไม่สำเร็จ");
        return;
      }
      setStatus(data.status || null);
      setOk("ลบคีย์บนเซิร์ฟเวอร์แล้ว");
      await load();
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
  const effectiveModel = status?.effectiveModel || status?.model || "—";
  const effectiveProvider =
    status?.effectiveProviderLabel || status?.effectiveProvider || "—";

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
            <strong>
              {status?.hasServerEnvKey
                ? status.serverEnvGeminiKeySource || "set via server"
                : "ยังไม่ตั้ง"}
            </strong>
          </li>
          <li>
            <span>คีย์ Cursor ของเซิร์ฟเวอร์</span>
            <strong>
              {status?.hasServerEnvCursorKey
                ? status.serverEnvCursorKeySource || "set via server"
                : "ยังไม่ตั้ง"}
            </strong>
          </li>
          <li>
            <span>คีย์ Gemini บนเซิร์ฟเวอร์ (ไฟล์)</span>
            <strong>
              {status?.hasServerFileGeminiKey
                ? status.maskedKey || "มี"
                : "ไม่มี"}
            </strong>
          </li>
          <li>
            <span>บังคับแผนพรีเมียม</span>
            <strong>
              {status?.premiumEnforceLabel ||
                (status?.premiumEnforce ? "บังคับแผนพรีเมียม" : "ไม่บังคับ")}
            </strong>
          </li>
          <li>
            <span>แหล่งคีย์ที่ใช้จริง</span>
            <strong>
              {status?.keySource === "user"
                ? "คีย์ผู้ใช้"
                : status?.keySource === "shared"
                  ? "คีย์ร่วมของเซิร์ฟเวอร์"
                  : "ยังไม่มีคีย์"}
            </strong>
          </li>
          <li>
            <span>ผู้ให้บริการที่ใช้จริง</span>
            <strong>{effectiveProvider}</strong>
          </li>
          <li>
            <span>โมเดลที่ใช้จริง (effective)</span>
            <strong>{effectiveModel}</strong>
          </li>
          <li>
            <span>ค่าเริ่มต้นผู้ให้บริการ (admin)</span>
            <strong>{status?.adminDefaultProvider || "google"}</strong>
          </li>
          <li>
            <span>โมเดลเริ่มต้นของ provider</span>
            <strong>{status?.defaultModel || "—"}</strong>
          </li>
          <li>
            <span>ที่เก็บคอนฟิก</span>
            <strong>{status?.configStoreLabel || "—"}</strong>
          </li>
        </ul>
        {status?.hasServerFileGeminiKey ? (
          <p className="admin-muted" style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              className="admin-btn admin-btn-danger"
              disabled={busy}
              onClick={() => void clearServerFileKey()}
            >
              ลบคีย์บนเซิร์ฟเวอร์ (ไฟล์)
            </button>
          </p>
        ) : null}
        <p className="admin-muted">
          คีย์จากเซิร์ฟเวอร์เป็นแบบอ่านอย่างเดียว (set via server) — ลบผ่าน UI ไม่ได้ · ไม่แสดงค่าคีย์
        </p>
        <p className="admin-muted">
          ผู้ให้บริการและโมเดลที่ใช้จริงด้านบนใช้ resolver เดียวกับแถบสถานะ (pill) บนหน้าแรก
        </p>
        {status?.studioUrl ? (
          <p className="admin-muted">
            <a
              className="admin-link"
              href={status.studioUrl}
              target="_blank"
              rel="noreferrer"
            >
              เอกสารผู้ให้บริการ
            </a>
          </p>
        ) : null}
      </section>

      <section className="admin-panel">
        <h2 className="admin-panel-title">โมเดลเริ่มต้น (admin)</h2>
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
          <p className="admin-muted">
            ค่านี้เป็นค่าตั้งต้นของแอดมิน — โมเดลที่ใช้จริงด้านบนอาจต่างออกไปเมื่อมีคีย์ Cursor
            หรือคีย์ผู้ใช้ (ตรงกับ pill)
          </p>
          <button type="submit" className="admin-btn admin-btn-primary" disabled={busy}>
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </form>
      </section>
    </div>
  );
}
