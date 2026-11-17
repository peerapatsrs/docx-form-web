import { HomeClient } from "@/app/home-client";
import { publicAssetUrl } from "@/lib/public-asset-version";
import { formatAppVersionLabel } from "@/lib/app-build-info";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readAppVersionLabel(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    ) as { version?: string };
    return formatAppVersionLabel(String(pkg.version || "0.0.0"));
  } catch {
    return formatAppVersionLabel("0.0.0");
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
