import { expect, test } from "@playwright/test";
import { EXPECTED, VECTORS } from "../vectors";

/**
 * The Phase 0 gate.
 *
 * A single-engine pass proves nothing here: the risk being tested is that two JS
 * engines disagree, so the assertion has to span engines. Playwright runs this file
 * once per configured project, and the recorded hashes in `vectors.ts` are what tie
 * the separate runs together into one claim.
 */

interface HarnessResult {
  version: string;
  hashes: Record<string, string>;
  error?: string;
}

async function readResult(page: import("@playwright/test").Page): Promise<HarnessResult> {
  await page.goto("/tests/harness/index.html");
  await page.waitForFunction(() => window.determinismResult !== undefined, undefined, {
    timeout: 30_000,
  });
  return page.evaluate(() => window.determinismResult as HarnessResult);
}

test("wasm core loads and reports its build flags", async ({ page }) => {
  const result = await readResult(page);
  expect(result.error).toBeUndefined();
  expect(result.version).toContain("relaxed_simd=false");
  expect(result.version).toContain("simd128=false");
});

test("every vector matches the hash recorded from the rust core", async ({ page }) => {
  const result = await readResult(page);
  expect(result.error).toBeUndefined();

  for (const vector of VECTORS) {
    expect(result.hashes[vector.name], `vector "${vector.name}" diverged`).toBe(
      EXPECTED[vector.name],
    );
  }
});

test("repeat runs in the same page agree", async ({ page }) => {
  await readResult(page);

  const repeated = await page.evaluate(() => {
    const hash = window.hashOnce;
    if (!hash) throw new Error("harness did not expose hashOnce");
    return [hash(42n, 600, 16), hash(42n, 600, 16)];
  });

  expect(repeated[0]).toBe(repeated[1]);
  expect(repeated[0]).toBe(EXPECTED.baseline);
});

test("hash is sensitive to seed and tick count", async ({ page }) => {
  await readResult(page);

  const { bySeed, byTicks } = await page.evaluate(() => {
    const hash = window.hashOnce;
    if (!hash) throw new Error("harness did not expose hashOnce");
    return {
      bySeed: [hash(42n, 600, 16), hash(43n, 600, 16)],
      byTicks: [hash(42n, 600, 16), hash(42n, 601, 16)],
    };
  });

  expect(bySeed[0]).not.toBe(bySeed[1]);
  expect(byTicks[0]).not.toBe(byTicks[1]);
});
