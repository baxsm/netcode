import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  worker: {
    format: "es",
  },
  server: {
    // the wasm package lives in core/, outside the served root
    fs: { allow: [".."] },
  },
  // wasm-pack output is already optimized, and inlining it would change the bytes
  // the determinism gate checks
  assetsInclude: ["**/*.wasm"],
});
