import { Hono } from "hono";
import JSZip from "jszip";
import {
  extractDocumentLayout,
  extractDocumentText,
  fillTemplate,
  formatTemplateError,
  parseTemplate,
  type FormField,
} from "./docx-engine";
import {
  clearGeminiKey,
  geminiStatus,
  getGeminiApiKey,
  getRequestGeminiKey,
  getRequestGeminiModel,
  isByokOnly,
  maskGeminiKey,
  normalizeGeminiModel,
  writeAiConfig,
} from "./ai-config";
import { geminiFillDocxFormValues } from "./gemini-map";
import { extractMany } from "./source-extract";
import {
  extractedMeta,
  type DocxFormValuesJson,
} from "./source-map";
import { tagTemplate, type TagReplacement } from "./template-tagger";
import {
  canUseFeature,
  PremiumFeature,
  premiumDeniedPayload,
  type PremiumFeatureId,
} from "./premium";

const MAX_DOCX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_SOURCE_FILES = 12;

function isDocx(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) return true;
  const t = (file.type || "").toLowerCase();
  return (
    t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    t === "application/octet-stream"
  );
}

function summarizeFields(fields: FormField[]) {
  let text = 0;
  let image = 0;
  let list = 0;
  let bool = 0;
  let auto = 0;
  for (const f of fields) {
    if (f.type === "text") text += 1;
    else if (f.type === "image") image += 1;
    else if (f.type === "bool") bool += 1;
    else if (f.type === "auto") auto += 1;
    else list += 1;
  }
  return { text, image, list, bool, auto };
}

export function createApi(options: { startedAt: Date; version?: string }) {
  const api = new Hono();

  async function requirePremium(
    c: { req: { raw: Request }; json: (body: unknown, status?: number) => Response },
    feature: PremiumFeatureId,
  ): Promise<Response | null> {
    const gate = await canUseFeature(feature, c.req.raw);
    if (gate.allowed) return null;
    return c.json(premiumDeniedPayload(feature), 402);
  }

  api.get("/health", async (c) => {
    const ent = await canUseFeature(PremiumFeature.AiSourceMap, c.req.raw);
    const reqKey = getRequestGeminiKey(c.req.raw);
    const reqModel = getRequestGeminiModel(c.req.raw);
    return c.json({
      ok: true,
      name: "docx-form-web",
      version: options.version || "0.0.0",
      author: "Peerapat Surasing",
      email: "peerapat.srs@gmail.com",
      startedAt: options.startedAt.toISOString(),
      ai: geminiStatus({ requestKey: reqKey, requestModel: reqModel }),
      premium: {
        enforce: String(process.env.PREMIUM_ENFORCE || "") === "1",
        paid: ent.entitlement.paid,
        plan: ent.entitlement.plan || "unknown",
      },
    });
  });

  api.get("/ai/status", (c) =>
    c.json(
      geminiStatus({
        requestKey: getRequestGeminiKey(c.req.raw),
        requestModel: getRequestGeminiModel(c.req.raw),
      }),
    ),
  );

  api.post("/ai/google", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.AiLogin);
    if (denied) return denied;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        apiKey?: string;
        model?: string;
        /** Legacy: persist on server (disabled when BYOK-only) */
        persist?: boolean;
      };
      const key = String(body.apiKey || "").trim();
      const model = normalizeGeminiModel(body.model);

      if (key && key.length < 20) {
        return c.json({ error: "กรุณาใส่ Gemini API key จาก Google AI Studio" }, 400);
      }
      if (!key && !model) {
        return c.json({ error: "ส่ง apiKey และ/หรือ model" }, 400);
      }

      // BYOK (default on web): validate + return status — key stays in the browser.
      if (isByokOnly() || body.persist === false) {
        if (!key && !getRequestGeminiKey(c.req.raw)) {
          return c.json(
            { error: "ต้องส่ง API key ของคุณ (เก็บในเบราว์เซอร์ ไม่บันทึกลงเซิร์ฟเวอร์)" },
            400,
          );
        }
        const effectiveKey = key || getRequestGeminiKey(c.req.raw) || "";
        return c.json({
          ok: true,
          ...geminiStatus({ requestKey: effectiveKey, requestModel: model }),
          maskedKey: maskGeminiKey(effectiveKey),
          connected: true,
          byok: true,
        });
      }

      // Legacy server-side store (local CLI style) — only when BYOK is off.
      const patch: { geminiApiKey?: string; geminiModel?: string } = {};
      if (key) patch.geminiApiKey = key;
      if (model) patch.geminiModel = model;
      if (patch.geminiModel && !patch.geminiApiKey && !getGeminiApiKey()) {
        return c.json({ error: "ต้องเชื่อมต่อ API key ก่อนเปลี่ยนโมเดล" }, 401);
      }
      writeAiConfig(patch);
      return c.json({ ok: true, ...geminiStatus() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  api.delete("/ai/google", (c) => {
    if (!isByokOnly()) clearGeminiKey();
    return c.json({
      ok: true,
      ...geminiStatus(),
      connected: false,
      byok: isByokOnly(),
    });
  });

  api.post("/parse", async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "กรุณาอัปโหลดไฟล์ .docx" }, 400);
      }
      if (!isDocx(file)) {
        return c.json(
          {
            error:
              file.name.toLowerCase().endsWith(".doc")
                ? "รองรับเฉพาะ .docx — ให้ Save As เป็น .docx ใน Word ก่อน"
                : "ไฟล์ต้องเป็น .docx เท่านั้น",
          },
          400,
        );
      }
      if (file.size > MAX_DOCX_BYTES) {
        return c.json({ error: "ไฟล์ใหญ่เกินไป (สูงสุด 25 MB)" }, 400);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const includeContent =
        String(form.get("includeContent") || "").toLowerCase() === "1" ||
        String(form.get("includeContent") || "").toLowerCase() === "true";

      const { fields } = await parseTemplate(buffer);

      if (fields.length === 0) {
        return c.json(
          {
            error:
              "ไม่พบตัวแปรในเทมเพลต — ใส่ {{ชื่อ}} ในข้อความ, แท็กใน Alt Text ของรูป, หรือ {{#รายการ}}…{{/}}",
            fields: [],
            filename: file.name,
          },
          400,
        );
      }

      const payload: Record<string, unknown> = {
        filename: file.name,
        fields,
        summary: summarizeFields(fields),
      };

      if (includeContent) {
        const layout = await extractDocumentLayout(buffer);
        payload.layout = layout.blocks;
        payload.content = await extractDocumentText(buffer);
        payload.contentIncluded = true;
      } else {
        payload.contentIncluded = false;
      }

      return c.json(payload);
    } catch (err) {
      const message = formatTemplateError(err);
      return c.json({ error: `อ่านเทมเพลตไม่สำเร็จ: ${message}` }, 400);
    }
  });

  api.post("/source-map", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.AiSourceMap);
    if (denied) return denied;

    const clientKey = getRequestGeminiKey(c.req.raw);
    const clientModel = getRequestGeminiModel(c.req.raw);
    if (!getGeminiApiKey(clientKey)) {
      return c.json(
        {
          error:
            "ยังไม่มี Gemini API key — กด «ใส่ Gemini key» แล้วใส่ key ของคุณ (เก็บในเบราว์เซอร์ ไม่ใช่คีย์ของแอป)",
        },
        401,
      );
    }

    const wantStream =
      c.req.query("stream") === "1" ||
      (c.req.header("accept") || "").includes("application/x-ndjson");

    try {
      const form = await c.req.formData();
      const fieldsRaw = form.get("fields");
      if (typeof fieldsRaw !== "string") {
        return c.json({ error: "ต้องส่ง fields เป็น JSON ของฟิลด์เทมเพลต" }, 400);
      }

      let fields: FormField[];
      try {
        const parsed = JSON.parse(fieldsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return c.json({ error: "fields ต้องเป็นอาร์เรย์ของฟิลด์ที่ไม่ว่าง" }, 400);
        }
        fields = parsed as FormField[];
      } catch {
        return c.json({ error: "fields ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }

      const seen = new Set<File>();
      const files: File[] = [];
      const pushFile = (val: FormDataEntryValue | null) => {
        if (!(val instanceof File) || seen.has(val)) return;
        seen.add(val);
        files.push(val);
      };
      for (const val of form.getAll("files")) pushFile(val);
      for (const [key, val] of form.entries()) {
        if (key === "files") continue;
        if (key === "file" || key.startsWith("file")) pushFile(val);
      }

      if (files.length === 0) {
        return c.json({ error: "กรุณาแนบไฟล์ต้นทางอย่างน้อย 1 ไฟล์ (.pdf / .docx / รูป)" }, 400);
      }
      if (files.length > MAX_SOURCE_FILES) {
        return c.json({ error: `แนบได้สูงสุด ${MAX_SOURCE_FILES} ไฟล์ต่อครั้ง` }, 400);
      }

      let total = 0;
      for (const f of files) {
        if (f.size <= 0) {
          return c.json({ error: `ไฟล์ ${f.name} ว่างเปล่า` }, 400);
        }
        if (f.size > MAX_SOURCE_FILE_BYTES) {
          return c.json({ error: `ไฟล์ ${f.name} ใหญ่เกิน 25 MB` }, 400);
        }
        total += f.size;
      }
      if (total > MAX_SOURCE_TOTAL_BYTES) {
        return c.json({ error: "ขนาดไฟล์รวมเกิน 40 MB" }, 400);
      }

      const payloads = await Promise.all(
        files.map(async (f) => ({
          buffer: Buffer.from(await f.arrayBuffer()),
          filename: f.name || "source",
          mimeType: f.type,
        })),
      );

      // JSON skeleton must come from the client (Export builder) at send-to-AI time —
      // never invented here on template upload.
      const valuesJsonRaw = form.get("valuesJson");
      if (typeof valuesJsonRaw !== "string" || !valuesJsonRaw.trim()) {
        return c.json(
          {
            error:
              "ต้องส่ง valuesJson ที่สร้างตอนจะส่งให้ AI (รูปแบบเดียวกับ Export JSON)",
          },
          400,
        );
      }
      let skeleton: DocxFormValuesJson;
      try {
        const parsed = JSON.parse(valuesJsonRaw) as DocxFormValuesJson;
        if (!parsed || parsed.format !== "docx-form-values") {
          return c.json(
            { error: "valuesJson ต้องเป็นรูปแบบ docx-form-values" },
            400,
          );
        }
        skeleton = parsed;
      } catch {
        return c.json({ error: "valuesJson ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }

      type ProgressEvt = {
        type: "log" | "progress" | "result" | "error";
        message?: string;
        step?: number;
        total?: number;
        label?: string;
        error?: string;
        valuesJson?: DocxFormValuesJson;
        values?: unknown;
        skip?: unknown;
        rowSkip?: unknown;
        extracted?: unknown;
        ai?: unknown;
      };

      const runMap = async (emit: (evt: ProgressEvt) => void | Promise<void>) => {
        const extractSteps = payloads.length;
        const totalSteps = extractSteps + 2; // extract*N + gemini once + done
        emit({
          type: "log",
          message: `เริ่มแมป ${payloads.length} ไฟล์ · โมเดล ${geminiStatus({ requestKey: clientKey, requestModel: clientModel }).model} · AI เติม Export JSON รอบเดียว`,
        });
        emit({
          type: "progress",
          step: 0,
          total: totalSteps,
          label: "เตรียมดึงข้อความจากเอกสาร",
        });

        const extracted = await extractMany(payloads, async (info) => {
          const kindLabel =
            info.kind === "image"
              ? "OCR รูป"
              : info.kind === "pdf"
                ? "อ่าน PDF"
                : info.kind === "docx"
                  ? "อ่าน Word"
                  : "อ่านไฟล์";
          if (info.phase === "start") {
            await emit({
              type: "log",
              message: `[${info.index + 1}/${info.total}] ${kindLabel}: ${info.filename}`,
            });
            await emit({
              type: "progress",
              step: info.index,
              total: totalSteps,
              label: `${kindLabel} — ${info.filename}`,
            });
          } else {
            const chars = info.result?.charCount ?? 0;
            const warn = info.result?.warning ? ` · ${info.result.warning}` : "";
            await emit({
              type: "log",
              message: `  ✓ ${info.filename}: ${chars} ตัวอักษร${warn}`,
            });
            await emit({
              type: "progress",
              step: info.index + 1,
              total: totalSteps,
              label: `ดึงข้อความแล้ว ${info.index + 1}/${info.total}`,
            });
          }
        });

        await emit({
          type: "log",
          message: `ส่งโครง Export JSON ให้ Gemini เติมค่า (1 ครั้ง)…`,
        });
        await emit({
          type: "progress",
          step: extractSteps + 1,
          total: totalSteps,
          label: "รอ JSON จาก Gemini",
        });

        const valuesJson = await geminiFillDocxFormValues(skeleton, extracted, {
          apiKey: clientKey,
          model: clientModel,
        });
        await emit({
          type: "log",
          message: `ได้ docx-form-values แล้ว — พร้อม Import`,
        });
        await emit({
          type: "progress",
          step: extractSteps + 2,
          total: totalSteps,
          label: "พร้อม Import JSON",
        });

        await emit({
          type: "result",
          valuesJson,
          values: valuesJson.values,
          skip: valuesJson.skip,
          rowSkip: valuesJson.rowSkip,
          extracted: extractedMeta(extracted),
          ai: { used: true, mode: "fill-export-json" },
          message: "แมปเสร็จ",
        });
      };

      if (!wantStream) {
        let payload: {
          valuesJson: DocxFormValuesJson;
          values: unknown;
          skip: unknown;
          rowSkip: unknown;
          extracted: unknown;
          ai: unknown;
        } | null = null;
        await runMap((evt) => {
          if (evt.type === "result" && evt.valuesJson) {
            payload = {
              valuesJson: evt.valuesJson,
              values: evt.values,
              skip: evt.skip,
              rowSkip: evt.rowSkip,
              extracted: evt.extracted,
              ai: evt.ai,
            };
          }
          if (evt.type === "error") throw new Error(evt.error || "แมปไม่สำเร็จ");
        });
        if (!payload) {
          return c.json({ error: "แมปเอกสารต้นทางไม่สำเร็จ" }, 400);
        }
        return c.json(payload);
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = async (evt: ProgressEvt) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(evt)}\n`));
          };
          try {
            await runMap(emit);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const banner = message.startsWith("แมปเอกสารต้นทางไม่สำเร็จ")
              ? message
              : `แมปเอกสารต้นทางไม่สำเร็จ — ${message}`;
            await emit({
              type: "error",
              error: banner,
              message,
            });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const banner = message.startsWith("แมปเอกสารต้นทางไม่สำเร็จ")
        ? message
        : `แมปเอกสารต้นทางไม่สำเร็จ — ${message}`;
      return c.json({ error: banner }, 400);
    }
  });

  api.post("/template/tag", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.TemplateTagger);
    if (denied) return denied;
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "กรุณาอัปโหลดไฟล์ .docx" }, 400);
      }
      if (!isDocx(file)) {
        return c.json(
          {
            error:
              file.name.toLowerCase().endsWith(".doc")
                ? "รองรับเฉพาะ .docx — ให้ Save As เป็น .docx ใน Word ก่อน"
                : "ไฟล์ต้องเป็น .docx เท่านั้น",
          },
          400,
        );
      }
      if (file.size > MAX_DOCX_BYTES) {
        return c.json({ error: "ไฟล์ใหญ่เกินไป (สูงสุด 25 MB)" }, 400);
      }

      const replacementsRaw = form.get("replacements");
      let replacements: TagReplacement[] = [];
      if (typeof replacementsRaw === "string" && replacementsRaw.trim()) {
        try {
          const parsed = JSON.parse(replacementsRaw) as unknown;
          if (!Array.isArray(parsed)) {
            return c.json({ error: "replacements ต้องเป็นอาร์เรย์" }, 400);
          }
          replacements = parsed as TagReplacement[];
        } catch {
          return c.json({ error: "replacements ต้องเป็น JSON ที่ถูกต้อง" }, 400);
        }
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await tagTemplate(buffer, replacements);
      const base = file.name.replace(/\.docx$/i, "") || "template";
      const outName = `${base}-tagged.docx`;

      return c.json({
        filename: outName,
        sourceFilename: file.name,
        plainText: result.plainText,
        content: result.content,
        layout: result.layout,
        replacementCount: replacements.length,
        docxBase64: result.buffer.toString("base64"),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `แท็กเทมเพลตไม่สำเร็จ: ${message}` }, 400);
    }
  });

  /**
   * One source pack → AI map to JSON per template schema (no document fill).
   * Form: files (sources×M), schemas = JSON [{ id, filename, fields }]
   */
  api.post("/batch-from-source", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.BatchFill);
    if (denied) return denied;

    try {
      const form = await c.req.formData();
      const formKey =
        typeof form.get("geminiApiKey") === "string"
          ? String(form.get("geminiApiKey") || "").trim()
          : "";
      const formModel =
        typeof form.get("geminiModel") === "string"
          ? String(form.get("geminiModel") || "").trim()
          : "";
      const clientKey = getRequestGeminiKey(c.req.raw) || formKey || undefined;
      const clientModel =
        getRequestGeminiModel(c.req.raw) ||
        normalizeGeminiModel(formModel) ||
        undefined;
      if (!getGeminiApiKey(clientKey)) {
        return c.json(
          {
            error:
              "ยังไม่มี Gemini API key — กด «ใส่ Gemini key» แล้วใส่ key ของคุณ (เก็บในเบราว์เซอร์ ไม่ใช่คีย์ของแอป)",
          },
          401,
        );
      }

      const schemasRaw = form.get("schemas");
      if (typeof schemasRaw !== "string") {
        return c.json(
          {
            error:
              "ต้องส่ง schemas เป็น JSON ของแต่ละเทมเพลต [{ id, filename, fields }]",
          },
          400,
        );
      }

      type SchemaItem = {
        id?: string;
        filename?: string;
        fields?: FormField[];
        /** Prefer client Export-JSON skeleton when present */
        valuesJson?: DocxFormValuesJson;
      };
      let schemas: SchemaItem[];
      try {
        const parsed = JSON.parse(schemasRaw) as unknown;
        if (!Array.isArray(parsed) || !parsed.length) {
          return c.json({ error: "schemas ต้องเป็นอาร์เรย์ที่ไม่ว่าง" }, 400);
        }
        schemas = parsed as SchemaItem[];
      } catch {
        return c.json({ error: "schemas ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }
      if (schemas.length > 12) {
        return c.json({ error: "แมปได้ไม่เกิน 12 เทมเพลตต่อครั้ง" }, 400);
      }

      const seenS = new Set<File>();
      const sources: File[] = [];
      const pushSource = (val: FormDataEntryValue | null) => {
        if (!(val instanceof File) || seenS.has(val)) return;
        seenS.add(val);
        sources.push(val);
      };
      for (const val of form.getAll("files")) pushSource(val);
      for (const [key, val] of form.entries()) {
        if (key === "files" || key === "schemas") continue;
        if (key === "geminiApiKey" || key === "geminiModel") continue;
        pushSource(val);
      }
      if (!sources.length) {
        return c.json({ error: "ต้องแนบเอกสารต้นทางอย่างน้อย 1 ไฟล์" }, 400);
      }

      let totalBytes = 0;
      for (const f of sources) {
        if (f.size > MAX_SOURCE_FILE_BYTES) {
          return c.json({ error: `ไฟล์ต้นทางใหญ่เกินไป: ${f.name}` }, 400);
        }
        totalBytes += f.size;
      }
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
        return c.json({ error: "รวมขนาดไฟล์ต้นทางใหญ่เกินไป" }, 400);
      }

      const payloads = await Promise.all(
        sources.map(async (f) => ({
          buffer: Buffer.from(await f.arrayBuffer()),
          filename: f.name || "source",
          mimeType: f.type,
        })),
      );
      const extracted = await extractMany(payloads);

      type BatchMapItem = {
        id: string | null;
        filename: string;
        ok: boolean;
        error?: string;
        fieldCount?: number;
        suggestions?: number;
        /** Same format as Export JSON / Import JSON */
        valuesJson?: DocxFormValuesJson;
      };
      const results: BatchMapItem[] = [];

      for (let i = 0; i < schemas.length; i += 1) {
        const schema = schemas[i];
        const name = String(
          schema.valuesJson?.template ||
            schema.filename ||
            `template-${i + 1}.docx`,
        );
        const id = schema.id != null ? String(schema.id) : null;
        try {
          const skeleton =
            schema.valuesJson && schema.valuesJson.format === "docx-form-values"
              ? schema.valuesJson
              : null;
          if (!skeleton) {
            results.push({
              id,
              filename: name,
              ok: false,
              error:
                "ต้องส่ง valuesJson ที่สร้างตอนจะส่งให้ AI (รูปแบบ Export JSON) — ไม่สร้างตอนโหลดไฟล์",
            });
            continue;
          }
          const valuesJson = await geminiFillDocxFormValues(
            skeleton,
            extracted,
            {
              apiKey: clientKey,
              model: clientModel,
            },
          );
          results.push({
            id,
            filename: name,
            ok: true,
            fieldCount: skeleton.fields?.length || 0,
            suggestions: Object.keys(valuesJson.values || {}).length,
            valuesJson,
          });
        } catch (err) {
          results.push({
            id,
            filename: name,
            ok: false,
            error: formatTemplateError(err),
          });
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      if (!okCount) {
        const reasons = results
          .map((r) => `${r.filename}: ${r.error || "ไม่ทราบสาเหตุ"}`)
          .slice(0, 4)
          .join(" · ");
        return c.json(
          {
            error: `แมป JSON ไม่สำเร็จทุกไฟล์ — ${reasons}`,
            results,
            extracted: extractedMeta(extracted),
          },
          400,
        );
      }

      return c.json({
        ok: true,
        mapped: okCount,
        total: results.length,
        results,
        extracted: extractedMeta(extracted),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `แมปหลายเทมเพลตไม่สำเร็จ: ${message}` }, 400);
    }
  });

  /**
   * Fill many templates from client-side form values → ZIP.
   * No AI. Form: templates (docx×N), items = JSON [{ filename, values }]
   */
  api.post("/batch-fill", async (c) => {
    const denied = await requirePremium(c, PremiumFeature.BatchFill);
    if (denied) return denied;

    try {
      const form = await c.req.formData();
      const templates: File[] = [];
      const seenT = new Set<File>();
      for (const val of form.getAll("templates")) {
        if (val instanceof File && !seenT.has(val)) {
          seenT.add(val);
          templates.push(val);
        }
      }
      if (!templates.length) {
        return c.json({ error: "ต้องส่งเทมเพลต .docx อย่างน้อย 1 ไฟล์" }, 400);
      }
      if (templates.length > 12) {
        return c.json({ error: "สร้างได้ไม่เกิน 12 ไฟล์ต่อครั้ง" }, 400);
      }

      const itemsRaw = form.get("items");
      if (typeof itemsRaw !== "string") {
        return c.json(
          { error: "ต้องส่ง items เป็น JSON [{ filename, values }]" },
          400,
        );
      }
      type FillItem = { filename?: string; values?: Record<string, unknown> };
      let items: FillItem[];
      try {
        const parsed = JSON.parse(itemsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== templates.length) {
          return c.json(
            { error: "จำนวน items ต้องเท่ากับจำนวนเทมเพลต" },
            400,
          );
        }
        items = parsed as FillItem[];
      } catch {
        return c.json({ error: "items ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }

      type BatchFillResult = {
        filename: string;
        ok: boolean;
        error?: string;
        filledName?: string;
      };
      const results: BatchFillResult[] = [];
      const zip = new JSZip();

      for (let i = 0; i < templates.length; i += 1) {
        const tmpl = templates[i];
        const name = tmpl.name || items[i]?.filename || `template-${i + 1}.docx`;
        try {
          if (!isDocx(tmpl) || tmpl.size > MAX_DOCX_BYTES) {
            results.push({
              filename: name,
              ok: false,
              error: "เทมเพลตไม่ถูกต้องหรือใหญ่เกินไป",
            });
            continue;
          }
          const values = items[i]?.values;
          if (!values || typeof values !== "object") {
            results.push({
              filename: name,
              ok: false,
              error: "ไม่มี values สำหรับเทมเพลตนี้",
            });
            continue;
          }
          const buffer = Buffer.from(await tmpl.arrayBuffer());
          const out = await fillTemplate({
            template: buffer,
            values,
            images: [],
          });
          const filledName = `${name.replace(/\.docx$/i, "") || "document"}-filled.docx`;
          zip.file(filledName, out);
          results.push({ filename: name, ok: true, filledName });
        } catch (err) {
          results.push({
            filename: name,
            ok: false,
            error: formatTemplateError(err),
          });
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      if (!okCount) {
        const reasons = results
          .map((r) => `${r.filename}: ${r.error || "ไม่ทราบสาเหตุ"}`)
          .slice(0, 4)
          .join(" · ");
        return c.json(
          {
            error: `สร้างเอกสารไม่สำเร็จทุกไฟล์ — ${reasons}`,
            results,
          },
          400,
        );
      }

      const zipBuf = Buffer.from(
        await zip.generateAsync({ type: "nodebuffer" }),
      );
      return c.json({
        ok: true,
        results,
        zipBase64: zipBuf.toString("base64"),
        zipName: `docx-form-batch-${okCount}files.zip`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `สร้างหลายเอกสารไม่สำเร็จ: ${message}` }, 400);
    }
  });

  api.post("/fill", async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "กรุณาส่งไฟล์เทมเพลต .docx" }, 400);
      }
      if (!isDocx(file) || file.size > MAX_DOCX_BYTES) {
        return c.json({ error: "ไฟล์เทมเพลตไม่ถูกต้องหรือใหญ่เกินไป" }, 400);
      }

      const valuesRaw = form.get("values");
      if (typeof valuesRaw !== "string") {
        return c.json({ error: "ต้องส่งค่า values เป็น JSON" }, 400);
      }

      let values: Record<string, unknown>;
      try {
        values = JSON.parse(valuesRaw) as Record<string, unknown>;
      } catch {
        return c.json({ error: "values ต้องเป็น JSON ที่ถูกต้อง" }, 400);
      }

      const images: {
        name: string;
        buffer: Buffer;
        filename: string;
        mimeType?: string;
      }[] = [];

      for (const [key, val] of form.entries()) {
        if (!key.startsWith("image:") || !(val instanceof File)) continue;
        const name = key.slice("image:".length);
        if (!name) continue;
        if (val.size === 0) continue;
        if (val.size > MAX_IMAGE_BYTES) {
          return c.json({ error: `รูป ${name} ใหญ่เกิน 8 MB` }, 400);
        }
        const type = (val.type || "").toLowerCase();
        if (
          type &&
          !type.startsWith("image/") &&
          type !== "application/octet-stream"
        ) {
          return c.json({ error: `ไฟล์สำหรับ ${name} ไม่ใช่รูปภาพ` }, 400);
        }
        images.push({
          name,
          buffer: Buffer.from(await val.arrayBuffer()),
          filename: val.name || `${name}.png`,
          mimeType: val.type,
        });
      }

      const template = Buffer.from(await file.arrayBuffer());
      const out = await fillTemplate({ template, values, images });

      const base = file.name.replace(/\.docx$/i, "") || "document";
      const utf8Name = `${base}-filled.docx`;
      // HTTP headers must be ASCII; keep a safe fallback + RFC 5987 for Thai names
      const asciiName =
        utf8Name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") ||
        "document-filled.docx";
      const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;

      return new Response(new Uint8Array(out), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": disposition,
        },
      });
    } catch (err) {
      const message = formatTemplateError(err);
      return c.json({ error: `สร้างเอกสารไม่สำเร็จ: ${message}` }, 400);
    }
  });

  return api;
}
