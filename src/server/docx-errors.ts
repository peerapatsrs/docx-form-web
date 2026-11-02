/**
 * Map library / ZIP / OOXML errors to clear in-app Thai messages.
 * Never surface third-party documentation URLs in the UI.
 */

import JSZip from "jszip";

const DOCS_URL_RE =
  /https?:\/\/[^\s)\]}'"]*(easy-template|github\.com|npmjs\.com|jszip)[^\s)\]}'"]*/gi;

/** Strip external documentation links from library messages. */
export function stripExternalDocLinks(message: string): string {
  return String(message || "")
    .replace(DOCS_URL_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/**
 * Detect OPC / OOXML encryption markers without fully parsing as a template.
 * Password-protected Office files often still look like a zip of encryption parts.
 */
export async function detectEncryptedOfficeDoc(
  buffer: Buffer,
): Promise<boolean> {
  if (!buffer?.length) return false;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);
    if (
      names.some(
        (n) =>
          /^EncryptionInfo$/i.test(n) ||
          /^EncryptedPackage$/i.test(n) ||
          /\/EncryptionInfo$/i.test(n) ||
          /\/EncryptedPackage$/i.test(n),
      )
    ) {
      return true;
    }
    // Encrypted Office often lacks word/document.xml
    const hasDocument = names.some((n) => /(^|\/)word\/document\.xml$/i.test(n));
    const hasEncrypted = names.some((n) => /encrypted/i.test(n));
    if (!hasDocument && hasEncrypted) return true;
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypted|password|AES|incorrect password/i.test(msg)) return true;
    return false;
  }
}

export async function assertDocxReadable(buffer: Buffer): Promise<void> {
  if (!buffer?.length) {
    throw new Error("ไฟล์ว่างเปล่า หรืออ่านไม่สำเร็จ");
  }
  // ZIP local file header is PK\x03\x04; empty/corrupt often fails later.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(
      "ไฟล์ไม่ใช่เอกสาร .docx ที่รองรับ — ตรวจนามสกุลหรือบันทึกใหม่จาก Word",
    );
  }
  if (await detectEncryptedOfficeDoc(buffer)) {
    throw new Error(
      "ไฟล์ถูกป้องกันด้วยรหัสผ่าน — เปิดใน Word แล้วปลดล็อก จากนั้น Save เป็น .docx ปกติ",
    );
  }
  try {
    const zip = await JSZip.loadAsync(buffer);
    const doc = zip.file("word/document.xml");
    if (!doc) {
      // Might still be encrypted under alternate packaging
      if (await detectEncryptedOfficeDoc(buffer)) {
        throw new Error(
          "ไฟล์ถูกป้องกันด้วยรหัสผ่าน — เปิดใน Word แล้วปลดล็อก จากนั้น Save เป็น .docx ปกติ",
        );
      }
      throw new Error(
        "ไฟล์ .docx ไม่สมบูรณ์ — ไม่พบ word/document.xml (อาจเสียหรือไม่ใช่เอกสาร Word)",
      );
    }
  } catch (err) {
    if (err instanceof Error && /รหัสผ่าน|ไม่สมบูรณ์|ไม่ใช่เอกสาร/.test(err.message)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypted|password|AES/i.test(msg)) {
      throw new Error(
        "ไฟล์ถูกป้องกันด้วยรหัสผ่าน — เปิดใน Word แล้วปลดล็อก จากนั้น Save เป็น .docx ปกติ",
      );
    }
    if (/corrupted|invalid|end of data|can't find end of central directory/i.test(msg)) {
      throw new Error(
        "ไฟล์ .docx เสียหรือเปิดไม่ได้ — ลอง Save As ใหม่จาก Word แล้วอัปโหลดอีกครั้ง",
      );
    }
    throw new Error(
      "อ่านแพ็กเกจ .docx ไม่สำเร็จ — ไฟล์อาจเสียหรือไม่ใช่เอกสารที่รองรับ",
    );
  }
}

/** Thai-friendly message for easy-template-x / ZIP / structure errors. */
export function formatTemplateError(err: unknown): string {
  const raw0 = err instanceof Error ? err.message : String(err);
  const raw = stripExternalDocLinks(raw0);

  if (
    /รหัสผ่าน|ป้องกันด้วยรหัสผ่าน|encrypted|password|AES|EncryptionInfo|EncryptedPackage/i.test(
      raw,
    )
  ) {
    return "ไฟล์ถูกป้องกันด้วยรหัสผ่าน — เปิดใน Word แล้วปลดล็อก จากนั้น Save เป็น .docx ปกติ";
  }
  if (
    /can't find end of central directory|corrupted zip|invalid zip|is this a zip/i.test(
      raw,
    )
  ) {
    return "ไฟล์ .docx เสียหรือเปิดไม่ได้ — ลอง Save As ใหม่จาก Word แล้วอัปโหลดอีกครั้ง";
  }
  if (/word\/document\.xml|ไม่พบ word\/document/i.test(raw)) {
    return "ไฟล์ .docx ไม่สมบูรณ์ — ไม่พบเนื้อหาเอกสารหลัก";
  }
  if (/ไฟล์ว่าง|ว่างเปล่า/.test(raw)) {
    return "ไฟล์ว่างเปล่า หรืออ่านไม่สำเร็จ";
  }
  if (/ไม่ใช่เอกสาร|\.docx ที่รองรับ/.test(raw)) {
    return raw;
  }

  const neverClosed = /Tag\s+\{\{#([^}]*)\}\}\s+is never closed/i.exec(raw);
  if (neverClosed) {
    const name = neverClosed[1].trim() || "(ว่าง)";
    return `แท็กเปิด {{#${name}}} ไม่มีแท็กปิด — ใส่ {{/${name}}} หรือ {{/}} หลังเนื้อหาในลูปนั้นในไฟล์ Word`;
  }
  const unexpectedClose = /unexpected\s+closing|Tag\s+\{\{\/([^}]*)\}\}/i.exec(raw);
  if (unexpectedClose) {
    return `พบแท็กปิดที่ไม่ตรงกับแท็กเปิด — ตรวจคู่ {{#…}} กับ {{/…}} ในเทมเพลต`;
  }
  if (/is never closed/i.test(raw)) {
    return `มีแท็กลูปที่ไม่ได้ปิด — ทุก {{#ชื่อ}} ต้องมี {{/ชื่อ}} หรือ {{/}} คู่กัน`;
  }
  if (/unclosed|not closed|missing (?:a )?closing/i.test(raw)) {
    return `แท็กไม่ปิด — ตรวจ {{…}} ให้ครบคู่ในเทมเพลต`;
  }
  if (/empty tag|tag name.*empty/i.test(raw)) {
    return `พบแท็กว่าง {{}} — ใส่ชื่อตัวแปรภายในแท็ก`;
  }
  if (/duplicate|already (?:defined|exists)/i.test(raw)) {
    return `พบชื่อตัวแปรซ้ำในโครงสร้างที่ไม่รองรับ — ใช้ชื่อเดียวต่อความหมาย หรือตรวจลูปซ้อน`;
  }

  // Drop residual English library noise when we have nothing better —
  // keep short Thai wrappers for generic parse failures.
  if (/^[A-Za-z0-9_.[\]\s:,'"\-]+$/.test(raw) && raw.length > 0) {
    return `อ่านเทมเพลตไม่สำเร็จ (${raw})`;
  }
  return raw || "อ่านเทมเพลตไม่สำเร็จ";
}
