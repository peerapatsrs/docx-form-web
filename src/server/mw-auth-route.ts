/**
 * Shared App Router helpers for OIDC handlers from @mw-shared/auth.
 */

import { NextResponse } from "next/server";
import {
  augmentWithBetterAuthCookies,
  getMwOidcHandlers,
} from "./mw-auth";
import { getAppBaseUrl } from "@/lib/app-base-url";
import { logOidcNotConfigured } from "./oidc-config";

function absoluteLocation(location: string | null): string | null {
  if (!location) return null;
  if (/^https?:\/\//i.test(location)) return location;
  const base = getAppBaseUrl();
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}

/**
 * Run a module handler and absolute-ize relative Location redirects for Next.
 */
export async function runMwOidcHandler(
  path: string,
  method: "GET" | "POST",
  request: Request,
): Promise<Response> {
  const handlers = getMwOidcHandlers();
  if (!handlers) {
    logOidcNotConfigured(path);
    return NextResponse.json(
      { error: "OIDC_DISABLED", code: "OIDC_DISABLED" },
      { status: 404 },
    );
  }
  const pair = handlers[path];
  if (!pair) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const fn = method === "POST" ? pair.POST : pair.GET;
  let response = await fn(request);
  response = await augmentWithBetterAuthCookies(response);

  const loc = response.headers.get("Location");
  const abs = absoluteLocation(loc);
  if (abs && abs !== loc) {
    const headers = new Headers(response.headers);
    headers.set("Location", abs);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}
