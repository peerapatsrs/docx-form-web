/**
 * Canonical product copy for README, <title>/<meta>, Open Graph, JSON-LD.
 * Keep one source so humans and Google see the same purpose.
 */

export const SITE_NAME = "docx-form";
export const SITE_NAME_FULL = "docx-form-web";

/** Short title for browser tab / SERP (≤ ~60 chars ideal). */
export const SITE_TITLE =
  "docx-form — กรอกแบบฟอร์ม Word ออนไลน์จากเทมเพลต .docx";

/** Meta description (≈150–160 chars) — what the product does. */
export const SITE_DESCRIPTION =
  "ระบบกรอกแบบฟอร์มเอกสาร Word (.docx) บนเว็บ: อัปโหลดเทมเพลตที่มีตัวแปร {{ชื่อฟิลด์}} กรอกผ่านฟอร์มในเบราว์เซอร์ ใช้ AI แมปข้อมูลจากไฟล์ต้นทาง แล้วดาวน์โหลดเอกสารที่กรอกครบ — ไม่ต้องติดตั้ง Microsoft Word";

/** Slightly longer blurb for README / JSON-LD / crawlable page copy. */
export const SITE_ABOUT = `docx-form เป็นเว็บแอปสำหรับสร้างเอกสารจากเทมเพลต Microsoft Word (.docx)
ผู้ใช้อัปโหลดไฟล์ที่มีแท็กตัวแปรแบบ {{ชื่อฟิลด์}} ระบบอ่านตัวแปรแล้วสร้างฟอร์มให้กรอกบนหน้าเว็บ
รองรับหลายเทมเพลตพร้อมกัน บันทึกดราฟ นำเข้า/ส่งออกค่าเป็น JSON และใช้ AI (คีย์ของผู้ใช้เอง — BYOK)
เพื่ออ่านเอกสารหรือไฟล์ต้นทางแล้วแมปค่าลงฟิลด์อัตโนมัติ จากนั้นสร้างไฟล์ .docx ที่กรอกครบพร้อมดาวน์โหลด`;

export const SITE_KEYWORDS = [
  "docx-form",
  "กรอกแบบฟอร์ม Word",
  "เทมเพลต docx",
  "เติมเอกสาร Word ออนไลน์",
  "mail merge ออนไลน์",
  "Word template form filler",
  "docx template",
  "AI document mapping",
  "กรอกฟอร์มเอกสาร",
  "easy-template-x",
] as const;

export const SITE_FEATURE_BULLETS = [
  "อัปโหลดเทมเพลต .docx ที่มีตัวแปร {{field}} แล้วกรอกผ่านฟอร์มในเบราว์เซอร์",
  "แท็กเกอร์ช่วยใส่/จัดการตัวแปรในเอกสาร",
  "หลายเทมเพลตต่อครั้ง (โควตาตามแผนฟรี/จ่ายแล้ว)",
  "AI แมปข้อมูลจากไฟล์ต้นทาง → ฟิลด์เทมเพลต (BYOK หลายผู้ให้บริการ)",
  "บันทึกดราฟ · Import/Export JSON · สร้างไฟล์หรือ ZIP ดาวน์โหลด",
  "ล็อกอิน OAuth / พาสคีย์ · บัญชีและแผนสมาชิก",
] as const;

export function absoluteUrl(path = "/"): string {
  const base = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
  if (!path || path === "/") return `${base}/`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function softwareApplicationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: SITE_NAME,
    alternateName: SITE_NAME_FULL,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: SITE_DESCRIPTION,
    url: absoluteUrl("/"),
    image: absoluteUrl("/brand/logo-mark.png"),
    author: {
      "@type": "Person",
      name: "Peerapat Surasing",
      email: "peerapat.srs@gmail.com",
    },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "THB",
      description: "มีแผนฟรีและแผนจ่ายแล้ว (โควตาหลายเทมเพลต)",
    },
    featureList: [...SITE_FEATURE_BULLETS],
    inLanguage: ["th", "en"],
  };
}
