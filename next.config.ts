import type { NextConfig } from "next";
import {
  HTML_CACHE_CONTROL,
  PRIVATE_NO_STORE_CACHE_CONTROL,
  VERSIONED_ASSET_CACHE_CONTROL,
  securityHeaders,
} from "./src/lib/security-headers";
import { LEGACY_HOME_REDIRECT_PATHS } from "./src/lib/legacy-routes";

const security = Object.entries(securityHeaders()).map(([key, value]) => ({
  key,
  value,
}));

const nextConfig: NextConfig = {
  output: "standalone",
  // Do not advertise the framework via x-powered-by.
  poweredByHeader: false,
  // Dev: allow both localhost and 127.0.0.1 (HMR was blocking 127.0.0.1 → blank page)
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: [
    "pdfjs-dist",
    "tesseract.js",
    "jszip",
    "easy-template-x",
    "pg",
    "better-auth",
    "@cursor/sdk",
  ],
  async redirects() {
    const legacy = LEGACY_HOME_REDIRECT_PATHS.flatMap((path) => [
      { source: path, destination: "/", permanent: false },
      { source: `${path}/`, destination: "/", permanent: false },
    ]);
    return [
      ...legacy,
      { source: "/settings", destination: "/account", permanent: false },
      { source: "/keys", destination: "/account", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: security,
      },
      {
        // Public HTML — short shared-cache lifetime
        source: "/",
        headers: [{ key: "Cache-Control", value: HTML_CACHE_CONTROL }],
      },
      {
        source: "/login",
        headers: [{ key: "Cache-Control", value: HTML_CACHE_CONTROL }],
      },
      {
        // Authenticated / user-specific HTML — never store in shared caches
        source: "/account",
        headers: [
          { key: "Cache-Control", value: PRIVATE_NO_STORE_CACHE_CONTROL },
        ],
      },
      {
        source: "/account/:path*",
        headers: [
          { key: "Cache-Control", value: PRIVATE_NO_STORE_CACHE_CONTROL },
        ],
      },
      {
        source: "/admin",
        headers: [
          { key: "Cache-Control", value: PRIVATE_NO_STORE_CACHE_CONTROL },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [
          { key: "Cache-Control", value: PRIVATE_NO_STORE_CACHE_CONTROL },
        ],
      },
      {
        // Content-hashed Next build assets — long-lived
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: VERSIONED_ASSET_CACHE_CONTROL },
        ],
      },
    ];
  },
};

export default nextConfig;
