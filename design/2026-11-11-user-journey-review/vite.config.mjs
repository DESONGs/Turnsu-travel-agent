import { fileURLToPath } from "node:url";
const dependency = path => fileURLToPath(new URL(`../../plugins/travel-agent-openai/workbench/node_modules/${path}`, import.meta.url));
export default {
  root: fileURLToPath(new URL("./", import.meta.url)),
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  resolve: { alias: [
    { find: /^preact\/jsx(?:-dev)?-runtime$/, replacement: dependency("preact/jsx-runtime/dist/jsxRuntime.module.js") },
    { find: "preact/hooks", replacement: dependency("preact/hooks/dist/hooks.module.js") },
    { find: "preact/compat", replacement: dependency("preact/compat/dist/compat.module.js") },
    { find: /^preact$/, replacement: dependency("preact/dist/preact.module.js") },
    { find: /^three$/, replacement: dependency("three/build/three.module.js") },
    { find: /^three\/addons\//, replacement: dependency("three/examples/jsm") + "/" },
  ], dedupe: ["preact", "three"] },
  server: { host: "127.0.0.1", port: 5176, strictPort: true },
};
