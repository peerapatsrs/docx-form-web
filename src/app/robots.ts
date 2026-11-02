import type { MetadataRoute } from "next";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Public indexing policy: allow the marketing/home surface; keep account,
 * admin, login, and API out of search indexes.
 */
export default function robots(): MetadataRoute.Robots {
  const base = getAppBaseUrl();
  let host: string | undefined;
  try {
    host = new URL(base).host;
  } catch {
    host = undefined;
  }
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/account", "/account/", "/admin", "/admin/", "/login"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    ...(host ? { host } : {}),
  };
}
