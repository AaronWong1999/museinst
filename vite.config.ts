import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";


export default defineConfig({
  root: path.resolve(__dirname, "src/web"),
  plugins: [react(), tailwindcss()],
  base: "/",
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
    },
  },
});
