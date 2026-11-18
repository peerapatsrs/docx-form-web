/**
 * Login loop breaker: count OIDC callback failures in a short-lived cookie.
 * 2+ failures within 60s → /login must not auto-redirect to Keycloak.
 */

export const OIDC_FAIL_COOKIE = "docx_oidc_fail";
export const OIDC_FAIL_WINDOW_MS = 60_000;
export const OIDC_FAIL_THRESHOLD = 2;

export type OidcFailState = {
  count: number;
  /** Window start (ms since epoch). */
  startedAt: number;
};

export function parseOidcFailCookie(
  raw: string | null | undefined,
  now = Date.now(),
): OidcFailState {
  const v = String(raw || "").trim();
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (!m) return { count: 0, startedAt: now };
  const count = Number(m[1]);
  const startedAt = Number(m[2]);
  if (!Number.isFinite(count) || !Number.isFinite(startedAt)) {
    return { count: 0, startedAt: now };
  }
  if (now - startedAt > OIDC_FAIL_WINDOW_MS) {
    return { count: 0, startedAt: now };
  }
  return { count, startedAt };
}

export function bumpOidcFailState(
  prev: OidcFailState,
  now = Date.now(),
): OidcFailState {
  if (now - prev.startedAt > OIDC_FAIL_WINDOW_MS || prev.count <= 0) {
    return { count: 1, startedAt: now };
  }
  return { count: prev.count + 1, startedAt: prev.startedAt };
}

export function serializeOidcFailState(state: OidcFailState): string {
  return `${Math.max(0, Math.floor(state.count))}.${Math.floor(state.startedAt)}`;
}

export function shouldBlockOidcAutoRedirect(
  raw: string | null | undefined,
  now = Date.now(),
): boolean {
  const state = parseOidcFailCookie(raw, now);
  return state.count >= OIDC_FAIL_THRESHOLD;
}

export function oidcFailSetCookieHeader(
  state: OidcFailState,
  secure: boolean,
): string {
  const secureAttr = secure ? "; Secure" : "";
  const maxAge = Math.ceil(OIDC_FAIL_WINDOW_MS / 1000);
  return `${OIDC_FAIL_COOKIE}=${serializeOidcFailState(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttr}`;
}

export function oidcFailClearCookieHeader(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_FAIL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

/** Thai + English messages for /login?error= codes (loop-safe error page). */
export function oidcLoginErrorCopy(errorCode: string): {
  title: string;
  lead: string;
  hint: string;
} {
  const code = String(errorCode || "")
    .trim()
    .slice(0, 80);
  if (code === "oidc_email_unverified") {
    return {
      title: "อีเมลยังไม่ยืนยันที่ Keycloak",
      lead: "บัญชีนี้มีอยู่ในระบบแล้ว แต่อีเมลจาก Keycloak ยังไม่ถูกยืนยัน และโหมดเชื่อถืออีเมล IdP ถูกปิดอยู่ — ไม่สร้างบัญชีซ้ำ",
      hint: "ยืนยันอีเมลใน Keycloak แล้วลองอีกครั้ง หรือติดต่อผู้ดูแล",
    };
  }
  if (code === "oidc_loop_guard") {
    return {
      title: "เข้าสู่ระบบล้มเหลวหลายครั้ง",
      lead: "ระบบหยุดการเปลี่ยนเส้นทางอัตโนมัติชั่วคราว เพื่อกันลูปเข้า Keycloak",
      hint: "รอสักครู่ หรือกดลองใหม่ / ออกจากระบบที่ Keycloak แล้วเข้าใหม่",
    };
  }
  if (code.startsWith("oidc_")) {
    return {
      title: "เข้าสู่ระบบไม่สำเร็จ",
      lead: `การยืนยันตัวตนกับ Keycloak ล้มเหลว (${code})`,
      hint: "ลองเข้าใหม่ หรือออกจากระบบที่ Keycloak แล้วลองอีกครั้ง",
    };
  }
  return {
    title: "เข้าสู่ระบบไม่สำเร็จ",
    lead: "เกิดข้อผิดพลาดระหว่างเข้าสู่ระบบ",
    hint: "ลองอีกครั้ง หรือออกจากระบบที่ Keycloak ก่อน",
  };
}
