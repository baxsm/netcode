import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // the e2e suite is playwright's, and vitest picking it up would run browser
    // tests in node and fail on the missing page fixture
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**", "core/**"],
    environment: "node",
  },
});
