import {
  MimeType,
  TagDisposition,
  TagPlacement,
  TemplateHandler,
  type ImageContent,
  type Tag,
  type TemplateData,
} from "easy-template-x";
import {
  assertDocxReadable,
  formatTemplateError as mapTemplateError,
} from "./docx-errors";
import { mergeSplitTemplateTagsInDocx } from "./docx-merge-tags";
import {
  fieldIdentityKey,
  fieldIdentityKeyFromTag,
  normalizeVarName,
  projectValuesOntoFields,
  validateUploadedTagName,
} from "./field-names";

/** Optional table-cell location for FE fill preview (non-loop + loop template cells). */
export type FieldTableLocation = {
  tableIndex?: number;
  rowIndexInTable?: number;
  cellIndex?: number;
};

export type TextField = {
  name: string;
  type: "text";
  /** Other exact tag names in the document that share this field. */
  aliases?: string[];
  location?: FieldTableLocation;
};
export type ImageField = {
  name: string;
  type: "image";
  aliases?: string[];
  location?: FieldTableLocation;
};
/** Checkbox: checked → trueText, unchecked → falseText. Tag e.g. {{พบ?√,x}} */
export type BoolField = {
  name: string;
  type: "bool";
  trueText: string;
  falseText: string;
  label: string;
  aliases?: string[];
  location?: FieldTableLocation;
};
/** Auto row number in loops. Tag e.g. {{+ลำดับ}} → 1, 2, 3… */
export type AutoField = {
  name: string;
  type: "auto";
  label: string;
  aliases?: string[];
  location?: FieldTableLocation;
};
export type ListItemField = TextField | BoolField | AutoField | ListField;
export type ListField = {
  name: string;
  type: "list";
  itemFields: ListItemField[];
  aliases?: string[];
  location?: FieldTableLocation;
};
export type FormField = TextField | ImageField | ListField | BoolField | AutoField;

/**
 * Bool tag forms:
 * - Preferred: `พบ?√,x` → label "พบ", true "√", false "x"
 * - Legacy: `?√,` / `?พบ|√,x`
 */
export function parseBoolTagName(raw: string): BoolField | null {
  const name = normalizeVarName(raw);

  // {{ชื่อ?จริง,เท็จ}} e.g. พบ?√,x
  const named = /^([^?]+)\?([^,]*),(.*)$/.exec(name);
  if (named) {
    const label = named[1].trim();
    if (!label) return null;
    return {
      name,
      type: "bool",
      trueText: named[2],
      falseText: named[3],
      label,
    };
  }

  // Legacy {{?จริง,เท็จ}} / {{?ชื่อ|จริง,เท็จ}}
  if (!name.startsWith("?")) return null;
  const body = name.slice(1);
  const withLabel = /^([^|]*)\|([^,]*),(.*)$/.exec(body);
  if (withLabel) {
    const trueText = withLabel[2];
    const falseText = withLabel[3];
    const label = withLabel[1].trim() || boolLabel(trueText, falseText);
    return { name, type: "bool", trueText, falseText, label };
  }
  const plain = /^([^,]*),(.*)$/.exec(body);
  if (!plain) return null;
  const trueText = plain[1];
  const falseText = plain[2];
  return {
    name,
    type: "bool",
    trueText,
    falseText,
    label: boolLabel(trueText, falseText),
  };
}

function boolLabel(trueText: string, falseText: string): string {
  const t = trueText || "(ว่าง)";
  if (falseText === "") return t;
  return `${t} / ${falseText}`;
}

/** `{{+ลำดับ}}` → auto-running number (1-based row index inside loops). */
export function parseAutoTagName(raw: string): AutoField | null {
  const name = normalizeVarName(raw);
  if (!name.startsWith("+")) return null;
  const label = name.slice(1).trim();
  if (!label) return null;
  return { name, type: "auto", label };
}

function selfTagToField(rawName: string): TextField | BoolField | AutoField {
  const auto = parseAutoTagName(rawName);
  if (auto) return auto;
  const bool = parseBoolTagName(rawName);
  if (bool) return bool;
  return { name: normalizeVarName(rawName), type: "text" };
}

function addAlias(
  field: { name: string; aliases?: string[] },
  rawName: string,
): void {
  const n = normalizeVarName(rawName);
  if (!n || n === field.name) return;
  if (!field.aliases) field.aliases = [];
  if (!field.aliases.includes(n)) field.aliases.push(n);
}

export type ParseResult = {
  fields: FormField[];
  warnings?: string[];
};

/**
 * skipEmptyTags: false — empty string / empty list removes the tag from output
 * (used when the user marks "ข้าม"). Unfilled-but-required is blocked in the UI.
 */
const handler = new TemplateHandler({
  skipEmptyTags: false,
  delimiters: {
    tagStart: "{{",
    tagEnd: "}}",
    containerTagOpen: "#",
    containerTagClose: "/",
  },
});

function mimeFromFilenameOrType(filename: string, mimeHint?: string): ImageContent["format"] {
  const lower = (filename || "").toLowerCase();
  const hint = (mimeHint || "").toLowerCase();
  if (hint.includes("jpeg") || hint.includes("jpg") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return MimeType.Jpeg;
  }
  if (hint.includes("gif") || lower.endsWith(".gif")) {
    return MimeType.Gif;
  }
  if (hint.includes("bmp") || lower.endsWith(".bmp")) {
    return MimeType.Bmp;
  }
  if (hint.includes("svg") || lower.endsWith(".svg")) {
    return MimeType.Svg;
  }
  return MimeType.Png;
}

type SeenMap = Map<string, FormField>;

function typePrefix(field: FormField): string {
  return field.type;
}

/**
 * Parse one {{#list}}…{{/}} spanning tags[openIndex]..close, preserving nested lists.
 * Returns the index after the matching Close tag.
 */
function parseListField(
  tags: Tag[],
  openIndex: number,
  warnings: string[],
): { field: ListField; nextIndex: number } {
  const open = tags[openIndex];
  const listName = normalizeVarName(open.name);
  const itemFields: ListItemField[] = [];
  const itemSeen: SeenMap = new Map();
  let i = openIndex + 1;

  const pushScalar = (raw: string) => {
    const n = normalizeVarName(raw);
    if (!n) return;
    const id = fieldIdentityKeyFromTag(n);
    const existing = itemSeen.get(id);
    if (existing) {
      addAlias(existing, n);
      return;
    }
    const field = selfTagToField(n);
    itemSeen.set(id, field);
    itemFields.push(field);
    const nameErr = validateUploadedTagName(n);
    if (nameErr) warnings.push(`${nameErr}: ${n}`);
  };

  while (i < tags.length && tags[i].disposition !== TagDisposition.Close) {
    const inner = tags[i];
    if (
      inner.disposition === TagDisposition.SelfClosed &&
      inner.placement === TagPlacement.TextNode
    ) {
      pushScalar(inner.name);
      i += 1;
      continue;
    }
    if (inner.disposition === TagDisposition.Open) {
      const nested = parseListField(tags, i, warnings);
      const id = `list:${fieldIdentityKey(nested.field.name)}`;
      const existing = itemSeen.get(id);
      if (existing && existing.type === "list") {
        addAlias(existing, nested.field.name);
      } else if (!itemSeen.has(id)) {
        itemSeen.set(id, nested.field);
        itemFields.push(nested.field);
      }
      i = nested.nextIndex;
      continue;
    }
    i += 1;
  }
  if (i < tags.length && tags[i].disposition === TagDisposition.Close) {
    i += 1;
  }

  return {
    field: { name: listName, type: "list", itemFields },
    nextIndex: i,
  };
}

/** Convert easy-template-x tags into a form schema for the UI (nested lists preserved). */
export function tagsToFields(tags: Tag[]): FormField[] {
  return tagsToFieldsWithWarnings(tags).fields;
}

export function tagsToFieldsWithWarnings(tags: Tag[]): {
  fields: FormField[];
  warnings: string[];
} {
  const fields: FormField[] = [];
  const seenTop: SeenMap = new Map();
  const warnings: string[] = [];
  let i = 0;

  const remember = (field: FormField, rawName: string) => {
    const id =
      field.type === "list"
        ? `list:${fieldIdentityKey(field.name)}`
        : `${typePrefix(field)}:${fieldIdentityKeyFromTag(rawName)}`;
    const existing = seenTop.get(id);
    if (existing) {
      addAlias(existing, rawName);
      // Cross-type collisions (rare): keep first, note it.
      if (existing.type !== field.type) {
        warnings.push(
          `ชื่อตัวแปร「${normalizeVarName(rawName)}」ซ้ำข้ามชนิด — ใช้ค่าจากช่องแรก`,
        );
      }
      return;
    }
    // Also block same identity under another type key.
    for (const [key, f] of seenTop) {
      if (
        key.endsWith(`:${fieldIdentityKeyFromTag(rawName)}`) ||
        key === `list:${fieldIdentityKey(rawName)}`
      ) {
        addAlias(f, rawName);
        return;
      }
    }
    seenTop.set(id, field);
    fields.push(field);
    if (field.type !== "list") {
      const nameErr = validateUploadedTagName(rawName);
      if (nameErr) warnings.push(`${nameErr}: ${normalizeVarName(rawName)}`);
    } else {
      const nameErr = validateUploadedTagName(field.name);
      if (nameErr) warnings.push(`${nameErr}: ${field.name}`);
    }
  };

  while (i < tags.length) {
    const tag = tags[i];

    if (tag.disposition === TagDisposition.Open) {
      const { field, nextIndex } = parseListField(tags, i, warnings);
      if (field.name) remember(field, field.name);
      i = nextIndex;
      continue;
    }

    if (tag.disposition === TagDisposition.SelfClosed) {
      const name = normalizeVarName(tag.name);
      if (!name) {
        i += 1;
        continue;
      }

      if (tag.placement === TagPlacement.Attribute) {
        remember({ name, type: "image" }, name);
      } else {
        remember(selfTagToField(name), name);
      }
    }

    i += 1;
  }

  return { fields, warnings };
}

/** Thai-friendly message for easy-template-x / structure errors. */
export function formatTemplateError(err: unknown): string {
  return mapTemplateError(err);
}

/** Ensure every {{#…}} has a matching close before fill. */
export function assertTagsBalanced(tags: Tag[]): void {
  const stack: string[] = [];
  for (const tag of tags) {
    if (tag.disposition === TagDisposition.Open) {
      stack.push(normalizeVarName(tag.name));
    } else if (tag.disposition === TagDisposition.Close) {
      if (stack.length === 0) {
        const name = normalizeVarName(tag.name);
        throw new Error(
          name
            ? `พบแท็กปิด {{/${name}}} โดยไม่มีแท็กเปิดคู่กัน`
            : `พบแท็กปิด {{/}} โดยไม่มีแท็กเปิดคู่กัน`,
        );
      }
      stack.pop();
    }
  }
  if (stack.length > 0) {
    const name = stack[stack.length - 1] || "(ว่าง)";
    throw new Error(`Tag {{#${name}}} is never closed.`);
  }
}

async function prepareTemplateBuffer(buffer: Buffer): Promise<Buffer> {
  await assertDocxReadable(buffer);
  return mergeSplitTemplateTagsInDocx(buffer);
}

/**
 * Attach `location` to fields that appear inside table cells (staticRows /
 * templateCells). First occurrence wins. Safe no-op when layout has no tables.
 */
export function enrichFieldsWithTableCellLocations(
  fields: FormField[],
  blocks: import("./docx-layout").LayoutBlock[],
  extractSelfTags: (text: string) => string[] = (text) => {
    const out: string[] = [];
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text || "")))) {
      const raw = String(m[1] || "").trim();
      if (!raw || raw.startsWith("#") || raw.startsWith("/")) continue;
      if (!out.includes(raw)) out.push(raw);
    }
    return out;
  },
): void {
  let tableIndex = -1;
  for (const b of blocks) {
    if (b.type !== "table") continue;
    tableIndex += 1;
    const attach = (
      cell: { text?: string; tags?: string[]; fieldName?: string },
      rowIndexInTable: number,
      cellIndex: number,
    ) => {
      const fromTags =
        Array.isArray(cell.tags) && cell.tags.length
          ? cell.tags
          : extractSelfTags(String(cell.text || ""));
      const names = cell.fieldName
        ? [String(cell.fieldName), ...fromTags]
        : fromTags;
      for (const raw of names) {
        const name = String(raw || "").trim();
        if (!name) continue;
        const field = fields.find(
          (f) => f.name === name || (f.aliases || []).includes(name),
        );
        if (!field || field.location) continue;
        field.location = { tableIndex, rowIndexInTable, cellIndex };
      }
    };
    const staticRows = b.staticRows || [];
    staticRows.forEach((row, ri) => {
      row.forEach((cell, ci) => attach(cell, ri, ci));
    });
    if (b.templateCells?.length) {
      const ri = b.headerRows?.length || 0;
      b.templateCells.forEach((cell, ci) => attach(cell, ri, ci));
    }
  }
}

export async function parseTemplate(buffer: Buffer): Promise<ParseResult> {
  const prepared = await prepareTemplateBuffer(buffer);
  const tags = await handler.parseTags(prepared);
  assertTagsBalanced(tags);
  const { fields, warnings } = tagsToFieldsWithWarnings(tags);
  try {
    const { extractDocumentLayout, extractSelfTagsFromCellText } = await import(
      "./docx-layout"
    );
    const layout = await extractDocumentLayout(prepared);
    enrichFieldsWithTableCellLocations(
      fields,
      layout.blocks,
      extractSelfTagsFromCellText,
    );
  } catch {
    /* layout enrichment is best-effort — fields still valid without location */
  }
  return warnings.length ? { fields, warnings } : { fields };
}

/** Plain-text preview of the whole .docx (body + headers + footers). */
export async function extractDocumentText(buffer: Buffer): Promise<string> {
  const { extractAllPlainText } = await import("./docx-layout");
  const text = await extractAllPlainText(buffer);
  if (text.trim()) return text;
  // Fallback to library main-document text if layout walk found nothing.
  const fallback = await handler.getText(buffer);
  return String(fallback || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type { DocumentLayout, LayoutBlock, LayoutTableBlock } from "./docx-layout";
export { extractDocumentLayout } from "./docx-layout";

export type FillImageInput = {
  name: string;
  buffer: Buffer;
  filename: string;
  mimeType?: string;
};

export type FillInput = {
  template: Buffer;
  values: Record<string, unknown>;
  images: FillImageInput[];
};

/** Copy a value onto the primary key and every alias (exact tag names). */
export function expandAliasValues(
  fields: FormField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  // Compat-project first so legacy NFKC keys land on current NFC field names.
  return projectValuesOntoFields(fields, values);
}

export async function fillTemplate(input: FillInput): Promise<Buffer> {
  const prepared = await prepareTemplateBuffer(input.template);
  const tags = await handler.parseTags(prepared);
  const { fields } = tagsToFieldsWithWarnings(tags);
  const remapped = expandAliasValues(fields, input.values as Record<string, unknown>);
  const data = { ...remapped } as TemplateData;

  for (const img of input.images) {
    const names = [img.name];
    const field = fields.find(
      (f) =>
        f.type === "image" &&
        (f.name === img.name || (f.aliases || []).includes(img.name)),
    );
    if (field) {
      names.length = 0;
      names.push(field.name, ...(field.aliases || []));
    }
    const content: ImageContent = {
      _type: "image",
      source: img.buffer,
      format: mimeFromFilenameOrType(img.filename, img.mimeType),
      altText: img.name,
    };
    for (const n of names) data[n] = content;
  }

  const out = await handler.process(prepared, data);
  return Buffer.from(out);
}
