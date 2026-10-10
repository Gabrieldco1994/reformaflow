import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("./node_modules/.vite", import.meta.url)),
  plugins: [react()],
  define: {
    "process.env.NEXT_PUBLIC_API_URL": JSON.stringify("http://localhost:3001"),
  },
  resolve: {
    alias: [
      {
        find: "@/contexts/project-context",
        replacement: fileURLToPath(
          new URL("./project-fixture.ts", import.meta.url),
        ),
      },
      {
        find: "@/lib/streaming-tts",
        replacement: fileURLToPath(
          new URL("./project-fixture.ts", import.meta.url),
        ),
      },
      {
        find: "@/contexts/auth-context",
        replacement: fileURLToPath(
          new URL("./auth-fixture.ts", import.meta.url),
        ),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("../../src", import.meta.url)),
      },
      {
        find: "@reformaflow/domain",
        replacement: fileURLToPath(
          new URL("../../../../packages/domain/src", import.meta.url),
        ),
      },
    ],
  },
  css: { postcss: fileURLToPath(new URL("../..", import.meta.url)) },
  server: { host: "127.0.0.1", port: 43147, strictPort: true },
});
