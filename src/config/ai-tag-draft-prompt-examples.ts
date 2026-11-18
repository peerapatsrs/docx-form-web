/**
 * Illustrative label/value examples for the AI tag-draft system prompt.
 * Kept out of server modules so embedded-data CI can allowlist via config/.
 * Examples are generic (not copied from production/QA forms).
 */
export const LABEL_VALUE_SPLIT_EXAMPLES = `
  Caption\\t\\tValue → {"plainText":"Value","label":"Caption",...}
  Prefix Longer value text (note) → {"plainText":"Longer value text","label":"Prefix",...}
  PrefixLonger value… (flush, no separator) → same split
  (Stem012-345-6789) / (Stem012-345-6789,012-345-6790) / (Stem office)
    → plainText = the value body (digits OR text); label = "Stem"
`.trim();

export const CONTACT_TAGGING_EXAMPLE =
  "e.g. 012-345-6789,098-765-4321); also tag emails like name@example.com";
