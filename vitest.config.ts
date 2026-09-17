import { defineConfig } from "vitest/config";

// Its own config, so the tests run as plain Node: `vite.config.ts` loads the
// Cloudflare plugin, which would start a workerd runtime the router does not
// need.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
