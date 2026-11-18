/**
 * Upload-time .docx validation shared by every endpoint that accepts a Word package.
 * Require a .docx filename and a ZIP whose [Content_Types].xml declares a
 * WordprocessingML *document* (not template) main part.
 */

import JSZip from "jszip";

/** Stable API error code for rejected uploads (wrong extension / package). */
export const UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE";

export const UNSUPPORTED_FILE_TYPE_MESSAGE =
  "รองรับเฉพาะไฟล์ .docx ที่เป็นเอกสาร Word — ตรวจนามสกุลและชนิดไฟล์";

/** OPC content type for a WordprocessingML document (not .dotx template). */
export const WORDPROCESSINGML_DOCUMENT_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

export function unsupportedFileTypeBody() {
  return {
    error: UNSUPPORTED_FILE_TYPE_MESSAGE,
    code: UNSUPPORTED_FILE_TYPE,
  } as const;
}

/** Filename must end with .docx (case-insensitive). MIME is ignored. */
export function hasDocxFilename(file: { name?: string | null }): boolean {
  return String(file?.name || "")
    .toLowerCase()
    .endsWith(".docx");
}

/** ZIP local/central header signature starts with "PK". */
export function hasZipPkSignature(buffer: Buffer): boolean {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 2 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b
  );
}

/**
 * True when buffer is a ZIP whose [Content_Types].xml declares the
 * WordprocessingML document main content type (rejects templates / non-Word ZIPs).
 * Templates use `…template.main+xml` and therefore fail this check.
 *
 * Also rejects empty, PK-only, truncated, and corrupt ZIP payloads (JSZip fails
 * or Content_Types is missing / wrong).
 */
export async function isWordprocessingMlDocumentPackage(
  buffer: Buffer,
): Promise<boolean> {
  // Empty / tiny buffers cannot be a real OPC package (need local header + CD).
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return false;
  if (!hasZipPkSignature(buffer)) return false;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const ctEntry =
      zip.file("[Content_Types].xml") || zip.file("/[Content_Types].xml");
    if (!ctEntry) return false;
    const xml = await ctEntry.async("string");
    return Boolean(xml && xml.includes(WORDPROCESSINGML_DOCUMENT_MAIN));
  } catch {
    return false;
  }
}

function unsupportedResult(): {
  ok: false;
  error: string;
  code: typeof UNSUPPORTED_FILE_TYPE;
} {
  return {
    ok: false,
    error: UNSUPPORTED_FILE_TYPE_MESSAGE,
    code: UNSUPPORTED_FILE_TYPE,
  };
}

/**
 * Full upload gate: .docx name + WordprocessingML document package.
 * Does not special-case individual filenames — only extension + package shape.
 * Rejects 0-byte, PK-only, truncated, and corrupt ZIPs with UNSUPPORTED_FILE_TYPE.
 */
export async function validateDocxUpload(
  file: { name?: string | null },
  buffer: Buffer,
): Promise<{ ok: true } | { ok: false; error: string; code: typeof UNSUPPORTED_FILE_TYPE }> {
  if (!hasDocxFilename(file)) return unsupportedResult();
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return unsupportedResult();
  if (!(await isWordprocessingMlDocumentPackage(buffer))) {
    return unsupportedResult();
  }
  return { ok: true };
}
