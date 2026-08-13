import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Captures the images the README embeds.
 *
 * Not a baseline suite. It writes into `public/readme/` so the pictures are committed
 * beside the code they show, and it is skipped outside Chromium since it produces
 * files rather than assertions.
 */

const OUT = "public/readme";

test.describe("readme", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "one engine is enough");

  test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

  const settle = async (page: Page, tick: number) => {
    await expect(page.getByTestId("theatre")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("tick-readout")).toContainText("of 399", { timeout: 30_000 });

    const play = page.getByTestId("play");
    await expect(async () => {
      if ((await play.innerText()) === "Pause") await play.click();
      await expect(play).toHaveText("Play");
      await page.waitForTimeout(150);
      await expect(play).toHaveText("Play");
    }).toPass({ timeout: 30_000 });

    await page.getByTestId("scrub").locator('input[type="range"]').evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      setter?.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, tick);
    await expect(page.getByTestId("tick-readout")).toContainText(`tick ${tick} `);

    const readout = page.getByTestId("tick-readout");
    await expect(async () => {
      const first = await readout.innerText();
      await page.waitForTimeout(120);
      expect(await readout.innerText()).toBe(first);
    }).toPass({ timeout: 10_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  };

  test("replay theatre", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto("/");
    await settle(page, 200);
    await page.screenshot({ path: `${OUT}/replay.png`, clip: { x: 0, y: 0, width: 1280, height: 780 } });

    // the measured comparison lower down the same route, which is where the effect of
    // the techniques is quantified rather than drawn
    // it appears only once every preset has finished, which is a run per network
    const table = page.getByTestId("results");
    await expect(table).toBeVisible({ timeout: 180_000 });
    await table.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await table
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
      .screenshot({ path: `${OUT}/comparison.png` });
  });

  test("pareto front", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#/tune");
    await expect(page.getByTestId("sweep-empty")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("run-sweep").click();

    // the empty state going away is what proves the run actually started. asserting on
    // the result panel alone passes against a page that never left idle
    await expect(page.getByTestId("sweep-empty")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("pareto-chart")).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId("result-metrics")).toBeVisible({ timeout: 30_000 });

    // the marks fade in, so the capture waits for that to finish
    await page.waitForTimeout(1200);

    /**
     * Captured as viewport clips around each panel rather than with `fullPage`.
     *
     * A fullPage shot of this route came out showing the pre-sweep empty state on a
     * page whose DOM provably no longer contained it, because the capture stitches
     * against a layout height measured before the result panels expanded it.
     */
    await page.getByTestId("pareto-chart").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/tune.png` });

    await page.getByTestId("result-metrics").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.getByTestId("sweep-result").screenshot({ path: `${OUT}/selected.png` });
  });

  test("verification", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#/verify");
    await expect(page.getByTestId("oracle-verdict")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("determinism-verdict")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("demo-list")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid$="-loading"]')).toHaveCount(0, { timeout: 60_000 });
    await page.waitForTimeout(600);

    // the oracle table on its own, since it is the external claim and the full page is
    // too tall to read at README width. see the note on the sweep above for why these
    // are element captures rather than fullPage
    await page
      .getByTestId("oracle-verdict")
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
      .screenshot({ path: `${OUT}/oracle.png` });

    await page.getByTestId("demo-list").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.getByTestId("demo-list").screenshot({ path: `${OUT}/failures.png` });
  });

  test("scenario authoring", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#/scenarios");
    await expect(page.getByTestId("read-only")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);

    // the population editor alone, which is the part worth showing at README width
    await page.getByTestId("segment-bar").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page
      .getByTestId("segment-bar")
      .locator('xpath=ancestor::*[@data-slot="card"][1]')
      .screenshot({ path: `${OUT}/population.png` });
  });
});
