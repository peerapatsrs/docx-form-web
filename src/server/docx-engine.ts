import {
  MimeType,
  TagDisposition,
  TagPlacement,
  TemplateHandler,
  type ImageContent,
  type Tag,
  type TemplateData,
} from "easy-template-x";

export type TextField = { name: string; type: "text" };
export type ImageField = { name: string; type: "image" };
/** Checkbox: checked → trueText, unchecked → falseText. Tag e.g. {{พบ?√,x}} */
export type BoolField = {
  name: string;
  type: "bool";
  trueText: string;
  falseText: string;
  label: string;
};
/** Auto row number in loops. Tag e.g. {{+ลำดับ}} → 1, 2, 3… */
export type AutoField = {
  name: string;
  type: "auto";
  label: string;
};
export type ListItemField = TextField | BoolField | AutoField;
export type ListField = {
  name: string;
  type: "list";
  itemFields: ListItemField[];
};
export type FormField = TextField | ImageField | ListField | BoolField | AutoField;

/**
 * Bool tag forms:
 * - Preferred: `พบ?√,x` → label "พบ", true "√", false "x"
 * - Legacy: `?√,` / `?พบ|√,x`
 */
export function parseBoolTagName(raw: string): BoolField | null {
  const name = raw.trim();

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
  const name = raw.trim();
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
  return { name: rawName.trim(), type: "text" };
}

export type ParseResult = {
  fields: FormField[];
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

/** Convert easy-template-x tags into a flat form schema for the UI. */
export function tagsToFields(tags: Tag[]): FormField[] {
  const fields: FormField[] = [];
  const seenTop = new Set<string>();
  let i = 0;

  while (i < tags.length) {
    const tag = tags[i];

    if (tag.disposition === TagDisposition.Open) {
      const listName = tag.name.trim();
      const itemFields: ListItemField[] = [];
      const itemSeen = new Set<string>();
      i += 1;

      const pushItem = (raw: string) => {
        const n = raw.trim();
        if (!n || itemSeen.has(n)) return;
        itemSeen.add(n);
        itemFields.push(selfTagToField(n));
      };

      while (i < tags.length && tags[i].disposition !== TagDisposition.Close) {
        const inner = tags[i];
        if (
          inner.disposition === TagDisposition.SelfClosed &&
          inner.placement === TagPlacement.TextNode
        ) {
          pushItem(inner.name);
        }
        if (inner.disposition === TagDisposition.Open) {
          let depth = 1;
          i += 1;
          while (i < tags.length && depth > 0) {
            if (tags[i].disposition === TagDisposition.Open) depth += 1;
            else if (tags[i].disposition === TagDisposition.Close) depth -= 1;
            else if (
              tags[i].disposition === TagDisposition.SelfClosed &&
              tags[i].placement === TagPlacement.TextNode
            ) {
              pushItem(tags[i].name);
            }
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      if (i < tags.length && tags[i].disposition === TagDisposition.Close) {
        i += 1;
      }

      if (listName && !seenTop.has(`list:${listName}`)) {
        seenTop.add(`list:${listName}`);
        fields.push({
          name: listName,
          type: "list",
          itemFields,
        });
      }
      continue;
    }

    if (tag.disposition === TagDisposition.SelfClosed) {
      const name = tag.name.trim();
      if (!name) {
        i += 1;
        continue;
      }

      if (tag.placement === TagPlacement.Attribute) {
        if (!seenTop.has(`image:${name}`)) {
          seenTop.add(`image:${name}`);
          fields.push({ name, type: "image" });
        }
      } else if (
        !seenTop.has(`text:${name}`) &&
        !seenTop.has(`bool:${name}`) &&
        !seenTop.has(`auto:${name}`) &&
        !seenTop.has(`image:${name}`) &&
        !seenTop.has(`list:${name}`)
      ) {
        const field = selfTagToField(name);
        if (field.type === "bool") {
          seenTop.add(`bool:${name}`);
          fields.push(field);
        } else if (field.type === "auto") {
          seenTop.add(`auto:${name}`);
          fields.push(field);
        } else {
          seenTop.add(`text:${name}`);
          fields.push(field);
        }
      }
    }

    i += 1;
  }

  return fields;
}

/** Thai-friendly message for easy-template-x / structure errors. */
export function formatTemplateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const neverClosed = /Tag\s+\{\{#([^}]*)\}\}\s+is never closed/i.exec(raw);
  if (neverClosed) {
    const name = neverClosed[1].trim() || "(ว่าง)";
    return (
      `แท็กเปิด {{#${name}}} ไม่มีแท็กปิด — ใส่ {{/${name}}} หรือ {{/}} หลังเนื้อหาในลูปนั้นในไฟล์ Word`
    );
  }
  const unexpectedClose = /unexpected\s+closing|Tag\s+\{\{\/([^}]*)\}\}/i.exec(raw);
  if (unexpectedClose) {
    return `พบแท็กปิดที่ไม่ตรงกับแท็กเปิด — ตรวจคู่ {{#…}} กับ {{/…}} ในเทมเพลต`;
  }
  if (/is never closed/i.test(raw)) {
    return `มีแท็กลูปที่ไม่ได้ปิด — ทุก {{#ชื่อ}} ต้องมี {{/ชื่อ}} หรือ {{/}} คู่กัน`;
  }
  return raw;
}

/** Ensure every {{#…}} has a matching close before fill. */
export function assertTagsBalanced(tags: Tag[]): void {
  const stack: string[] = [];
  for (const tag of tags) {
    if (tag.disposition === TagDisposition.Open) {
      stack.push(tag.name.trim());
    } else if (tag.disposition === TagDisposition.Close) {
      if (stack.length === 0) {
        const name = tag.name.trim();
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

export async function parseTemplate(buffer: Buffer): Promise<ParseResult> {
  const tags = await handler.parseTags(buffer);
  assertTagsBalanced(tags);
  return { fields: tagsToFields(tags) };
}

/** Plain-text preview of the whole .docx (for optional UI detail panel). */
export async function extractDocumentText(buffer: Buffer): Promise<string> {
  const text = await handler.getText(buffer);
  return String(text || "")
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

export async function fillTemplate(input: FillInput): Promise<Buffer> {
  const data = { ...input.values } as TemplateData;

  for (const img of input.images) {
    const content: ImageContent = {
      _type: "image",
      source: img.buffer,
      format: mimeFromFilenameOrType(img.filename, img.mimeType),
      altText: img.name,
    };
    data[img.name] = content;
  }

  const out = await handler.process(input.template, data);
  return Buffer.from(out);
}
