/**
 * Illustrative label/value examples for the AI tag-draft system prompt.
 * Kept out of server modules so embedded-data CI can allowlist via config/.
 */
export const LABEL_VALUE_SPLIT_EXAMPLES = `
  ประเภทหนี้\\t\\tกู้ยืม → {"plainText":"กู้ยืม","label":"ประเภทหนี้",...}
  มอบหมายให้ บริษัท กฎหมาย บีไอจี จำกัด (ตัวอย่าง) → {"plainText":"บริษัท กฎหมาย บีไอจี จำกัด","label":"มอบหมายให้",...}
  มอบหมายให้บริษัท กฎหมาย บีไอจี จำกัด… (flush) → same split
  (โทร02-023-2599) / (โทร02-023-2599,02-023-2591) / (โทรสำนักงานใหญ่)
    → plainText = the value body (digits OR text); label = "โทร"
`.trim();

export const CONTACT_TAGGING_EXAMPLE =
  "e.g. 02-023-2599,096-392-3963); also tag emails like biglegal@…";
