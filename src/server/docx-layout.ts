import JSZip from "jszip";

export type CellAlign = "left" | "center" | "right" | "both";

export type LayoutCell = {
  text: string;
  colspan?: number;
  rowspan?: number;
  /** Paragraph horizontal alignment from Word (w:jc). */
  align?: CellAlign;
  /** Preferred width in twips (dxa) from w:tcW or tblGrid. */
  widthDxa?: number;
};

export type LayoutTextBlock = { type: "text"; text: string; role?: "header" | "footer" | "body" };
export type LayoutImageBlock = {
  type: "image";
  /** Alt text / description when available. */
  alt?: string;
  /** Which document region the image came from. */
  role?: "header" | "footer" | "body";
};
export type LayoutTableBlock = {
  type: "table";
  /** Header rows from Word (with colspan/rowspan). */
  headerRows: LayoutCell[][];
  /** Loop list name if this table row is a {{#name}}…{{/}} template. */
  listName?: string;
  /** Data-row cells with {{#}} / {{/}} stripped; tags remain for fields. */
  templateCells: LayoutCell[];
  /**
   * Sample/body rows that still sit below the loop template in Word.
   * New wrap-row tagging strips these; kept here so tagger preview can show leftovers.
   */
  trailingRows?: LayoutCell[][];
  /** Static table (no loop) — all rows including body. */
  staticRows?: LayoutCell[][];
  /** Column widths from w:tblGrid (dxa). */
  colWidths?: number[];
  /** Word floating table (tblpPr) — visual order may differ from XML order. */
  floating?: boolean;
  role?: "header" | "footer" | "body";
};
export type LayoutBlock = LayoutTextBlock | LayoutTableBlock | LayoutImageBlock;

export type DocumentLayout = {
  blocks: LayoutBlock[];
};

type RawCell = {
  text: string;
  colspan: number;
  vMerge: "restart" | "continue" | null;
  startCol: number;
  align?: CellAlign;
  widthDxa?: number;
};

function mapJc(val: string | undefined): CellAlign | undefined {
  if (!val) return undefined;
  switch (val) {
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "both":
    case "distribute":
      return "both";
    case "left":
    case "start":
      return "left";
    default:
      return undefined;
  }
}

/** First explicit w:jc in the cell (usually the first paragraph). */
function parseCellAlign(tcXml: string): CellAlign | undefined {
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(tcXml))) {
    const p = m[1];
    const jc = mapJc(/<w:jc\b[^>]*\bw:val="([^"]*)"/.exec(p)?.[1]);
    if (jc) return jc;
    if (/<w:t[\s>]/.test(p)) break;
  }
  return undefined;
}

function parseTcWidth(tcXml: string): number | undefined {
  const pr = /<w:tcPr\b[^>]*>([\s\S]*?)<\/w:tcPr>/.exec(tcXml)?.[1] || "";
  const w =
    /<w:tcW\b[^>]*\bw:w="(\d+)"[^>]*\bw:type="dxa"/.exec(pr)?.[1] ||
    /<w:tcW\b[^>]*\bw:type="dxa"[^>]*\bw:w="(\d+)"/.exec(pr)?.[1];
  if (!w) return undefined;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseTblGridWidths(tblInner: string): number[] | undefined {
  const grid = /<w:tblGrid\b[^>]*>([\s\S]*?)<\/w:tblGrid>/.exec(tblInner)?.[1];
  if (!grid) return undefined;
  const widths: number[] = [];
  const re = /<w:gridCol\b[^>]*\bw:w="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(grid))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) widths.push(n);
  }
  return widths.length ? widths : undefined;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Cell/paragraph plain: <w:t> text with <w:tab/> as \\t (Word tab spacing). */
function cellPlainText(tcXml: string): string {
  let out = "";
  const re = /<w:tab\b[^>]*\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tcXml))) {
    if (m[0].startsWith("<w:tab")) out += "\t";
    else out += decodeXmlEntities(m[1] || "");
  }
  return out;
}

function parseTcProps(tcXml: string): { colspan: number; vMerge: RawCell["vMerge"] } {
  const pr = /<w:tcPr\b[^>]*>([\s\S]*?)<\/w:tcPr>/.exec(tcXml)?.[1] || "";
  let colspan = 1;
  const gs = /<w:gridSpan\b[^>]*\bw:val="(\d+)"/.exec(pr);
  if (gs) colspan = Math.max(1, Number(gs[1]) || 1);

  let vMerge: RawCell["vMerge"] = null;
  const vMergeTag = /<w:vMerge\b([^>]*)\/?>/.exec(pr);
  if (vMergeTag) {
    const val = /\bw:val="([^"]*)"/.exec(vMergeTag[1] || "")?.[1];
    // Word: val="restart" starts a merge; bare <w:vMerge/> continues it
    vMerge = val === "restart" ? "restart" : "continue";
  }
  return { colspan, vMerge };
}

function parseTableRawRows(tblInner: string): RawCell[][] {
  const rows: RawCell[][] = [];
  const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(tblInner))) {
    const cells: RawCell[] = [];
    let startCol = 0;
    const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let tc: RegExpExecArray | null;
    while ((tc = tcRe.exec(tr[1]))) {
      const { colspan, vMerge } = parseTcProps(tc[1]);
      const align = parseCellAlign(tc[1]);
      const widthDxa = parseTcWidth(tc[1]);
      cells.push({
        text: cellPlainText(tc[1]),
        colspan,
        vMerge,
        startCol,
        ...(align ? { align } : {}),
        ...(widthDxa ? { widthDxa } : {}),
      });
      startCol += colspan;
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function cellCovering(row: RawCell[], col: number): RawCell | null {
  for (const cell of row) {
    if (col >= cell.startCol && col < cell.startCol + cell.colspan) return cell;
  }
  return null;
}

/** Convert raw Word cells into HTML-ready cells (skip vMerge continue, set rowspan). */
function resolveMerges(rows: RawCell[][]): LayoutCell[][] {
  return rows.map((row, ri) => {
    const out: LayoutCell[] = [];
    for (const cell of row) {
      if (cell.vMerge === "continue") continue;
      let rowspan = 1;
      if (cell.vMerge === "restart") {
        for (let j = ri + 1; j < rows.length; j++) {
          const below = cellCovering(rows[j], cell.startCol);
          if (below && below.vMerge === "continue") rowspan += 1;
          else break;
        }
      }
      const layout: LayoutCell = { text: cell.text };
      if (cell.colspan > 1) layout.colspan = cell.colspan;
      if (rowspan > 1) layout.rowspan = rowspan;
      if (cell.align) layout.align = cell.align;
      if (cell.widthDxa) layout.widthDxa = cell.widthDxa;
      out.push(layout);
    }
    return out;
  });
}

function paragraphPlainText(pXml: string): string {
  return cellPlainText(pXml);
}

function paragraphHasDrawing(pXml: string): boolean {
  return /<w:drawing\b|<w:pict\b|<w:object\b/i.test(pXml);
}

function paragraphImageAlt(pXml: string): string {
  const descr =
    /descr="([^"]*)"/.exec(pXml)?.[1] ||
    /name="([^"]*)"/.exec(pXml)?.[1] ||
    "";
  return decodeXmlEntities(descr).trim();
}

/** Resolve header/footer part paths from document.xml.rels (and fall back to word/header*.xml). */
async function resolveHeaderFooterParts(
  zip: JSZip,
  documentXml: string,
): Promise<{ headers: string[]; footers: string[] }> {
  const headers: string[] = [];
  const footers: string[] = [];
  const seen = new Set<string>();
  const push = (kind: "header" | "footer", path: string) => {
    const norm = path.replace(/^\//, "");
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    if (kind === "header") headers.push(norm);
    else footers.push(norm);
  };

  const relsFile =
    zip.file("word/_rels/document.xml.rels") ||
    zip.file("word/_rels/document.xml.rels".toLowerCase());
  const relsXml = relsFile ? await relsFile.async("string") : "";
  const idToTarget = new Map<string, string>();
  if (relsXml) {
    const relRe =
      /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(relsXml))) {
      idToTarget.set(rm[1], rm[2].replace(/^\//, ""));
    }
  }

  const refRe = /<w:(headerReference|footerReference)\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(documentXml))) {
    const kind = m[1] === "headerReference" ? "header" : "footer";
    const id = /\br:id="([^"]+)"/.exec(m[2] || "")?.[1];
    if (!id) continue;
    const target = idToTarget.get(id);
    if (!target) continue;
    const path = target.startsWith("word/") ? target : `word/${target}`;
    push(kind, path);
  }

  // Fallback: include any header/footer parts present in the package.
  if (!headers.length || !footers.length) {
    for (const name of Object.keys(zip.files)) {
      if (/^word\/header\d*\.xml$/i.test(name)) push("header", name);
      if (/^word\/footer\d*\.xml$/i.test(name)) push("footer", name);
    }
  }
  return { headers, footers };
}

/**
 * Parse a header/footer/body XML fragment into layout blocks (text, tables, image markers).
 */
function parseXmlRegion(
  xml: string,
  role: "header" | "footer" | "body",
): LayoutBlock[] {
  const rootMatch =
    /<(?:w:hdr|w:ftr|w:body)\b[^>]*>([\s\S]*)<\/(?:w:hdr|w:ftr|w:body)>/i.exec(
      xml,
    );
  const region = rootMatch ? rootMatch[1] : xml;
  const blocks: LayoutBlock[] = [];
  let textBuf: string[] = [];
  const flushText = () => {
    const text = textBuf.join("").replace(/\n{3,}/g, "\n\n").trim();
    if (text) blocks.push({ type: "text", text, role });
    textBuf = [];
  };

  let pos = 0;
  while (pos < region.length) {
    const tblAt = region.indexOf("<w:tbl", pos);
    const pAt = region.indexOf("<w:p", pos);
    if (tblAt < 0 && pAt < 0) break;

    if (tblAt >= 0 && (pAt < 0 || tblAt <= pAt)) {
      const end = region.indexOf("</w:tbl>", tblAt);
      if (end < 0) break;
      const tblXml = region.slice(tblAt, end + "</w:tbl>".length);
      const inner = tblXml.replace(/^<w:tbl\b[^>]*>/, "").replace(/<\/w:tbl>$/, "");
      flushText();
      const floating = /<w:tblpPr\b/.test(tblXml);
      const rows = parseTableRawRows(inner);
      const colWidths = parseTblGridWidths(inner);
      if (rows.length) {
        const block = tableToBlock(rows, floating, colWidths);
        block.role = role;
        blocks.push(block);
      }
      pos = end + "</w:tbl>".length;
      continue;
    }

    if (pAt >= 0) {
      const slice = region.slice(pAt, pAt + 6);
      if (!(slice.startsWith("<w:p>") || slice.startsWith("<w:p "))) {
        pos = pAt + 4;
        continue;
      }
      const end = region.indexOf("</w:p>", pAt);
      if (end < 0) break;
      const pXml = region.slice(pAt, end + "</w:p>".length);
      if (paragraphHasDrawing(pXml)) {
        flushText();
        blocks.push({
          type: "image",
          alt: paragraphImageAlt(pXml) || undefined,
          role,
        });
      }
      const t = paragraphPlainText(pXml);
      if (t) textBuf.push(t + "\n");
      else if (!paragraphHasDrawing(pXml)) textBuf.push("\n");
      pos = end + "</w:p>".length;
      continue;
    }
    break;
  }
  flushText();
  return blocks;
}

function stripLoopWrappers(cell: string): string {
  return cell
    .replace(/\{\{#([^}]*)\}\}/g, "")
    .replace(/\{\{\/([^}]*)\}\}/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function rawToTemplateCell(cell: RawCell): LayoutCell {
  const layout: LayoutCell = { text: stripLoopWrappers(cell.text) };
  if (cell.align) layout.align = cell.align;
  if (cell.widthDxa) layout.widthDxa = cell.widthDxa;
  if (cell.colspan > 1) layout.colspan = cell.colspan;
  return layout;
}

function tableToBlock(
  rawRows: RawCell[][],
  floating = false,
  colWidths?: number[],
): LayoutTableBlock {
  const resolved = resolveMerges(rawRows);
  const cols = colWidths?.length ? { colWidths } : {};
  for (let i = 0; i < rawRows.length; i++) {
    const joined = rawRows[i].map((c) => c.text).join("");
    const open = /\{\{#([^}]*)\}\}/.exec(joined);
    if (open) {
      const trailing = resolved.slice(i + 1);
      return {
        type: "table",
        headerRows: resolved.slice(0, i),
        listName: open[1].trim(),
        templateCells: rawRows[i].map(rawToTemplateCell),
        ...(trailing.length ? { trailingRows: trailing } : {}),
        floating: floating || undefined,
        ...cols,
      };
    }
  }
  return {
    type: "table",
    headerRows: [],
    templateCells: [],
    staticRows: resolved,
    floating: floating || undefined,
    ...cols,
  };
}

/**
 * Floating Word tables often sit before their caption in XML but appear below it on screen.
 * Pull an immediate following intro paragraph (e.g. “…ดังต่อไปนี้”) to before the table.
 */
function reorderFloatingTableCaptions(blocks: LayoutBlock[]): LayoutBlock[] {
  const out: LayoutBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "table" && b.floating && i + 1 < blocks.length && blocks[i + 1].type === "text") {
      const next = blocks[i + 1] as LayoutTextBlock;
      const paras = next.text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      const first = paras[0] || "";
      const looksLikeCaption =
        /ดังต่อไปนี้\s*$/.test(first) ||
        /ดังนี้\s*$/.test(first) ||
        (!!b.listName && first.includes(b.listName));
      if (looksLikeCaption && first) {
        out.push({ type: "text", text: first });
        out.push(b);
        const rest = paras.slice(1).join("\n").trim();
        blocks[i + 1] = { type: "text", text: rest };
        continue;
      }
    }
    if (b.type === "text" && !b.text.trim()) continue;
    out.push(b);
  }
  return out;
}

/**
 * Walk document headers, body, and footers: paragraphs → text, drawings → image
 * markers, tables → real table structure (for fill form + tagger preview).
 */
export async function extractDocumentLayout(buffer: Buffer): Promise<DocumentLayout> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) return { blocks: [] };
  const xml = await file.async("string");
  const { headers, footers } = await resolveHeaderFooterParts(zip, xml);

  const blocks: LayoutBlock[] = [];

  for (const path of headers) {
    const part = zip.file(path);
    if (!part) continue;
    const partXml = await part.async("string");
    const regionBlocks = parseXmlRegion(partXml, "header");
    if (regionBlocks.length) {
      blocks.push({
        type: "text",
        text: "— ส่วนหัวเอกสาร —",
        role: "header",
      });
      blocks.push(...regionBlocks);
    }
  }

  blocks.push(...parseXmlRegion(xml, "body"));

  for (const path of footers) {
    const part = zip.file(path);
    if (!part) continue;
    const partXml = await part.async("string");
    const regionBlocks = parseXmlRegion(partXml, "footer");
    if (regionBlocks.length) {
      blocks.push({
        type: "text",
        text: "— ส่วนท้ายเอกสาร —",
        role: "footer",
      });
      blocks.push(...regionBlocks);
    }
  }

  return { blocks: reorderFloatingTableCaptions(blocks) };
}
