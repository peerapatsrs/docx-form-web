import { auth } from "@/server/auth";
import { withResolvedClientIpHeaders } from "@/server/client-ip";
import { toNextJsHandler } from "better-auth/next-js";

const { GET: authGet, POST: authPost } = toNextJsHandler(auth);

/** Normalize proxy headers so Better Auth rate limits bind to a real client IP. */
function withClientIp(handler: (request: Request) => Promise<Response>) {
  return (request: Request) => handler(withResolvedClientIpHeaders(request));
}

export const GET = withClientIp(authGet);
export const POST = withClientIp(authPost);
