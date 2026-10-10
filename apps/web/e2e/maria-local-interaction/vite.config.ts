import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      "@reformaflow/domain": fileURLToPath(
        new URL("../../../../packages/domain/src", import.meta.url),
      ),
    },
  },
  css: { postcss: fileURLToPath(new URL("../..", import.meta.url)) },
  server: { host: "127.0.0.1", port: 43127, strictPort: true },
});
