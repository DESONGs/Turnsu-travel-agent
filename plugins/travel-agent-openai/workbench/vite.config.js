import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  resolve: { dedupe: ["three"] },
  build: { cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER },
});
