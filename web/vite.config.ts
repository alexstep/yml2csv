import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");

export default defineConfig({
  root: webRoot,
  base: process.env.BASE_PATH || "/",
  publicDir: path.join(webRoot, "public"),
  build: {
    outDir: path.join(webRoot, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    fs: { allow: [repoRoot] },
  },
});
