import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Dev: allow both localhost and 127.0.0.1 (HMR was blocking 127.0.0.1 → blank page)
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["pdfjs-dist", "tesseract.js", "jszip", "easy-template-x"],
};

export default nextConfig;
