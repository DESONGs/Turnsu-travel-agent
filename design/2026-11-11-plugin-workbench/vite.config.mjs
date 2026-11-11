import { fileURLToPath } from "node:url";
export default { root: fileURLToPath(new URL("./", import.meta.url)), server: { host: "127.0.0.1", port: 5175, strictPort: true } };
