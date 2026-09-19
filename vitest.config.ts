import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Its own config, so the tests run as plain Node: `vite.config.ts` loads the
// Cloudflare plugin, which would start a workerd runtime the router does not
// need. The React plugin *is* here — component tests need JSX and Fast
// Refresh's runtime — but it is the only one.
export default defineConfig({
  plugins: [react()],
  // The components copied from `dembrane-portal-redesign` import through `@/`,
  // as they do under `vite.config.ts`; a test that renders one resolves the
  // same way.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    // Node is the default because most of what is worth testing here is plain
    // logic. A test that renders React opts itself into a DOM with a
    // `@vitest-environment jsdom` docblock, so no server test pays for one.
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
