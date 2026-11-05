import { HomeClient } from "@/app/home-client";
import { publicAssetUrl } from "@/lib/public-asset-version";
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

/** Server shell — client UI + /public/app.js boot live in HomeClient. */
export default function Home() {
  return (
    <HomeClient
      appJsSrc={publicAssetUrl("app.js")}
      fieldNamesSrc={publicAssetUrl("field-names.js")}
      versionLabel={readAppVersionLabel()}
    />
  );
}
