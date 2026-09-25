import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare({ tunnel: { autoStart: process.env.CF_TUNNEL === "1" } }),
    tailwindcss(),
  ],
  resolve: {
    // `agents` is linked from the monorepo checkout, so `agents/react` would
    // otherwise resolve React through that tree and give the app two copies.
    dedupe: ["react", "react-dom"],
    // The components copied from `dembrane-portal-redesign` import through
    // `@/`, the alias their `components.json` declares. Mirrored in
    // `tsconfig.json` so the editor and the bundler agree.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
