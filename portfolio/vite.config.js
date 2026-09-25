import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Deploys as a GitHub Pages project site: https://lambwright.github.io/ledger/
// — has to live under lambwright.github.io to share the suite's Einbau ID
// login (the token is in that origin's localStorage). The Procore sidebar
// stays on Cloudflare Pages; this is only the company-level view.
//
// Dev proxy: auth-worker's CORS is locked to https://lambwright.github.io, so
// /auth goes through Vite in dev (same pattern as HELM/TALLY/HANDOFF). The
// LEDGER worker allows any origin, so it's called directly.
export default defineConfig({
  base: "/ledger/",
  plugins: [react()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5174,
    proxy: {
      "/auth": {
        target: "https://auth.ben-a90.workers.dev",
        changeOrigin: true,
      },
    },
  },
});
