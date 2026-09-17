import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  // `agents` is linked from the monorepo checkout, so `agents/react` would
  // otherwise resolve React through that tree and give the app two copies.
  resolve: { dedupe: ["react", "react-dom"] }
});
