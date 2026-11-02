import type { MetadataRoute } from "next";
import { absoluteAppUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Sitemap for publicly indexable pages only (home). Authenticated and API
 * surfaces are omitted on purpose.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteAppUrl("/"),
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
