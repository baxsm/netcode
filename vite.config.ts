import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // the determinism harness imports the wasm package from core/, which sits
    // outside the default served root
    fs: { allow: [".."] },
  },
  // wasm-pack output is already optimized, and letting vite inline it would change
  // the bytes the determinism gate is checking
  assetsInclude: ["**/*.wasm"],
});
