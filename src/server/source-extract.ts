import JSZip from "jszip";

export type ExtractedTable = {
  headers: string[];
  rows: string[][];
};

export type ExtractedSource = {
  filename: string;
  kind: "docx" | "pdf" | "image" | "unknown";
  text: string;
  lines: string[];
  tables: ExtractedTable[];
  charCount: number;
  warning?: string;
};

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function cellPlainText(tcXml: string): string {
  let out = "";
  const re = /<w:tab\b[^>]*\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tcXml))) {
    if (m[0].startsWith("<w:tab")) out += " ";
    else out += decodeXmlEntities(m[1] || "");
  }
  return out.replace(/\s+/g, " ").trim();
}

function paragraphPlainText(pXml: string): string {
  let out = "";
  const re = /<w:tab\b[^>]*\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml))) {
    if (m[0].startsWith("<w:tab")) out += " ";
    else out += decodeXmlEntities(m[1] || "");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Keep empty cells so column indexes stay aligned (critical for sparse legal tables). */
function formatTableRow(cells: string[]): string {
  return cells.map((c) => (c && c.trim() ? c.trim() : "—")).join(" | ");
}

function formatTableBlock(rows: string[][], tableIndex: number): string[] {
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const padded = r.slice();
    while (padded.length < width) padded.push("");
    return padded;
  });
  const out: string[] = [`[TABLE ${tableIndex + 1} · ${width} columns]`];
  for (const row of norm) {
    out.push(formatTableRow(row));
  }
  out.push(`[END TABLE ${tableIndex + 1}]`);
  return out;
}

function extractDocxFromXml(xml: string): { lines: string[]; tables: ExtractedTable[] } {
  const lines: string[] = [];
  const tables: ExtractedTable[] = [];

  // Walk body children in order: paragraphs and tables
  const body = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml)?.[1] || xml;
  const tokenRe = /<(w:tbl|w:p)\b[^>]*>[\s\S]*?<\/\1>/g;
  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(body))) {
    const chunk = tok[0];
    if (chunk.startsWith("<w:tbl")) {
      const rows: string[][] = [];
      const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let tr: RegExpExecArray | null;
      while ((tr = trRe.exec(chunk))) {
        const cells: string[] = [];
        const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let tc: RegExpExecArray | null;
        while ((tc = tcRe.exec(tr[1]))) {
          const text = cellPlainText(tc[1]);
          const spanRaw = /<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(tc[1]);
          const span = Math.max(1, Number(spanRaw?.[1] || 1) || 1);
          // Expand horizontal merges so column indexes match data rows.
          cells.push(text);
          for (let s = 1; s < span; s += 1) cells.push("");
        }
        if (cells.some((c) => c.length > 0)) rows.push(cells);
      }
      if (rows.length > 0) {
        const headers = rows[0];
        const dataRows = rows.slice(1);
        tables.push({ headers, rows: dataRows.length ? dataRows : [] });
        // Preserve empty cells — dropping them shifts "ปัจจุบัน" values into "ภูมิลำเนา" columns.
        lines.push(...formatTableBlock(rows, tables.length - 1));
      }
    } else {
      const text = paragraphPlainText(chunk);
      if (text) lines.push(text);
    }
  }

  return { lines, tables };
}

async function extractDocx(buffer: Buffer, filename: string): Promise<ExtractedSource> {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    return {
      filename,
      kind: "docx",
      text: "",
      lines: [],
      tables: [],
      charCount: 0,
      warning: "ไม่พบ word/document.xml ในไฟล์ .docx",
    };
  }
  const xml = await docFile.async("string");
  const { lines, tables } = extractDocxFromXml(xml);
  const text = lines.join("\n");
  return {
    filename,
    kind: "docx",
    text,
    lines,
    tables,
    charCount: text.length,
    warning: text.length < 8 ? "อ่านข้อความจาก .docx ได้น้อยมาก" : undefined,
  };
}

async function extractPdf(buffer: Buffer, filename: string): Promise<ExtractedSource> {
  // pdfjs legacy build works in Node without a DOM
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;
  const lines: string[] = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      let current = "";
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!item || typeof item !== "object" || !("str" in item)) continue;
        const str = String((item as { str?: string }).str || "");
        if (!str) continue;
        const transform = (item as { transform?: number[] }).transform;
        const y = Array.isArray(transform) ? transform[5] : null;
        if (lastY != null && y != null && Math.abs(lastY - y) > 2) {
          if (current.trim()) lines.push(current.trim());
          current = str;
        } else {
          current = current ? `${current}${str}` : str;
        }
        if (y != null) lastY = y;
      }
      if (current.trim()) lines.push(current.trim());
    }
  } finally {
    const closer = doc as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    if (typeof closer.destroy === "function") await closer.destroy();
    else if (typeof closer.cleanup === "function") await closer.cleanup();
  }
  const text = lines.join("\n");
  return {
    filename,
    kind: "pdf",
    text,
    lines,
    tables: [],
    charCount: text.length,
    warning:
      text.length < 12
        ? "ดึงข้อความจาก PDF ได้น้อย — อาจเป็นสแกนภาพ ลองแนบรูปแล้วใช้ OCR"
        : undefined,
  };
}

async function extractImage(buffer: Buffer, filename: string): Promise<ExtractedSource> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("tha+eng");
  try {
    const result = await worker.recognize(buffer);
    const text = String(result.data.text || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      filename,
      kind: "image",
      text,
      lines,
      tables: [],
      charCount: text.length,
      warning: text.length < 8 ? "OCR อ่านข้อความได้น้อยมาก" : undefined,
    };
  } finally {
    await worker.terminate();
  }
}

function detectKind(
  filename: string,
  mimeType?: string,
): ExtractedSource["kind"] {
  const name = filename.toLowerCase();
  const mime = (mimeType || "").toLowerCase();
  if (name.endsWith(".docx") || mime.includes("wordprocessingml")) return "docx";
  if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".webp") ||
    name.endsWith(".gif") ||
    name.endsWith(".bmp") ||
    mime.startsWith("image/")
  ) {
    return "image";
  }
  return "unknown";
}

export async function extractSourceFile(input: {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}): Promise<ExtractedSource> {
  const kind = detectKind(input.filename, input.mimeType);
  if (kind === "docx") return extractDocx(input.buffer, input.filename);
  if (kind === "pdf") return extractPdf(input.buffer, input.filename);
  if (kind === "image") return extractImage(input.buffer, input.filename);
  return {
    filename: input.filename,
    kind: "unknown",
    text: "",
    lines: [],
    tables: [],
    charCount: 0,
    warning: "ชนิดไฟล์ไม่รองรับ (ใช้ .pdf / .docx / รูป png·jpg·webp)",
  };
}

export async function extractMany(
  files: { buffer: Buffer; filename: string; mimeType?: string }[],
  onProgress?: (info: {
    index: number;
    total: number;
    filename: string;
    kind: ExtractedSource["kind"];
    phase: "start" | "done";
    result?: ExtractedSource;
  }) => void | Promise<void>,
): Promise<ExtractedSource[]> {
  const out: ExtractedSource[] = [];
  const total = files.length;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const kind = detectKind(f.filename, f.mimeType);
    await onProgress?.({ index: i, total, filename: f.filename, kind, phase: "start" });
    const result = await extractSourceFile(f);
    out.push(result);
    await onProgress?.({
      index: i,
      total,
      filename: f.filename,
      kind: result.kind,
      phase: "done",
      result,
    });
  }
  return out;
}
