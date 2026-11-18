import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/workerd/**"],
    globals: false,
    testTimeout: 30_000,
  },
});
