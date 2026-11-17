/**
 * Single source for advertised docx upload cap and the Next.js proxy body buffer.
 * next.config.ts and upload routes must derive limits from here — no scattered literals.
 */

/** Advertised max .docx file size (25 MB). */
export const MAX_DOCX_BYTES = 25 * 1024 * 1024;

/**
 * Multipart MIME overhead margin on top of the file cap
 * (boundaries, Content-Disposition headers, extra form fields).
 */
export const MULTIPART_BODY_OVERHEAD_BYTES = 1 * 1024 * 1024;

/**
 * Max request body Next.js should buffer when proxy clones the body.
 * Config key: `experimental.proxyClientMaxBodySize`.
 */
export const MAX_UPLOAD_BODY_BYTES =
  MAX_DOCX_BYTES + MULTIPART_BODY_OVERHEAD_BYTES;

/** Default stable error code when a route has no more specific *_TOO_LARGE. */
export const FILE_TOO_LARGE = "FILE_TOO_LARGE";

export const FILE_TOO_LARGE_MESSAGE = "ไฟล์ใหญ่เกินไป (สูงสุด 25 MB)";

/** Prefer 413 Payload Too Large for oversize uploads. */
export const UPLOAD_TOO_LARGE_STATUS = 413 as const;

export function uploadTooLargeBody(code: string = FILE_TOO_LARGE) {
  return {
    error: FILE_TOO_LARGE_MESSAGE,
    code,
  } as const;
}

/** Content-Length (when present) exceeds file cap + multipart margin. */
export function isContentLengthTooLarge(contentLength: number): boolean {
  const n = Number(contentLength);
  return Number.isFinite(n) && n > 0 && n > MAX_UPLOAD_BODY_BYTES;
}

/** Parsed file size exceeds the advertised docx cap. */
export function isFileSizeTooLarge(size: number): boolean {
  const n = Number(size);
  return Number.isFinite(n) && n > MAX_DOCX_BYTES;
}

/**
 * Shared size pre-check: Content-Length (if known) and/or file size after parse.
 * Returns a JSON body + 413 status, or null when within limits.
 */
export function checkUploadSizeLimits(opts: {
  contentLengthHeader?: string | null;
  fileSize?: number | null;
  code?: string;
}): { body: { error: string; code: string }; status: typeof UPLOAD_TOO_LARGE_STATUS } | null {
  const code = opts.code || FILE_TOO_LARGE;
  const cl = Number(opts.contentLengthHeader || 0);
  if (isContentLengthTooLarge(cl)) {
    return { body: uploadTooLargeBody(code), status: UPLOAD_TOO_LARGE_STATUS };
  }
  if (
    opts.fileSize != null &&
    opts.fileSize !== undefined &&
    isFileSizeTooLarge(opts.fileSize)
  ) {
    return { body: uploadTooLargeBody(code), status: UPLOAD_TOO_LARGE_STATUS };
  }
  return null;
}
