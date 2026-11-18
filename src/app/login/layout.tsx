import type { ReactNode } from "react";
import { GuestSiteChrome } from "@/components/GuestSiteChrome";
import { redirectIfAuthenticated } from "@/lib/server-auth";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readAppVersionLabel(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    ) as { version?: string };
    const raw = String(pkg.version || "0.0.0").replace(/^v/i, "");
    return raw ? `v${raw}` : "v…";
  } catch {
    return "v…";
  }
}

export default async function LoginLayout({
  children,
}: {
  children: ReactNode;
}) {
  await redirectIfAuthenticated("/");
  return (
    <GuestSiteChrome versionLabel={readAppVersionLabel()}>
      {children}
    </GuestSiteChrome>
  );
}
