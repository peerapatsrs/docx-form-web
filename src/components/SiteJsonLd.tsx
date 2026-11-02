import { connection } from "next/server";
import { softwareApplicationJsonLd } from "@/lib/site-meta";

/** Machine-readable product description for Google / rich results. */
export async function SiteJsonLd() {
  // Request-time so absolute URLs use the deployed base URL env, not build placeholders.
  await connection();
  const data = softwareApplicationJsonLd();
  return (
    <script
      type="application/ld+json"
      // JSON-LD is trusted static product copy from site-meta — not user HTML.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
