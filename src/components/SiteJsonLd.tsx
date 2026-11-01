import { softwareApplicationJsonLd } from "@/lib/site-meta";

/** Machine-readable product description for Google / rich results. */
export function SiteJsonLd() {
  const data = softwareApplicationJsonLd();
  return (
    <script
      type="application/ld+json"
      // JSON-LD is trusted static product copy from site-meta — not user HTML.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
