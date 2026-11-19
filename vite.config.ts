/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
    },
  },
  root: "src/renderer",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  test: {
    setupFiles: ["./src/test-setup.ts"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
