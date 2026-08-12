import { expect, test, type Page } from "@playwright/test";

/**
 * Visual baselines for the replay theatre.
 *
 * These are stable rather than flaky because the simulation is deterministic: a fixed
 * seed and a fixed tick produce the same pixels every run. That is a direct benefit of
 * the Phase 0 property, and this is the layer that catches the visual regressions the
 * other suites structurally cannot.
 *
 * Playback is always paused and scrubbed to an exact tick first. Capturing while the
 * animation loop is running would compare two different moments and fail for no
 * reason.
 */

const settle = async (page: Page, tick: number) => {
  await page.goto("/");
  await expect(page.getByTestId("theatre")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tick-readout")).toContainText("of 399", { timeout: 30_000 });

  // pause before scrubbing, so the cursor cannot move between the seek and the capture
  const play = page.getByTestId("play");
  if ((await play.innerText()) === "Pause") await play.click();
  await expect(play).toHaveText("Play");

  await page.getByTestId("scrub").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, tick);
  await expect(page.getByTestId("tick-readout")).toContainText(`tick ${tick} `);

  // one frame for the canvases to repaint from the new cursor
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
};

/** The part of the page the theatre occupies, captured whole rather than cropped. */
const TOP = { x: 0, y: 0, width: 1280, height: 720 };

/**
 * Only Chromium holds baselines. Font rasterisation differs between engines, so a
 * Firefox baseline would either need its own file or fail on antialiasing that has
 * nothing to do with the view.
 */
test.describe("baselines", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "baselines are Chromium's");

  // captured against the viewport rather than the theatre element, so the page margins
  // are inside the frame. cropping to the element hides exactly the kind of edge
  // clipping these baselines exist to catch
  test("the theatre mid run", async ({ page }) => {
    await settle(page, 200);
    await expect(page).toHaveScreenshot("theatre-tick-200.png", { clip: TOP });
  });

  test("the opening tick, before any state has arrived", async ({ page }) => {
    await settle(page, 0);
    // no ghost can exist yet, so this pins that nothing authoritative is drawn early
    await expect(page).toHaveScreenshot("theatre-tick-0.png", { clip: TOP });
  });

  test("a single view close up", async ({ page }) => {
    await settle(page, 200);
    await expect(page.getByTestId("view-A")).toHaveScreenshot("view-a-tick-200.png");
  });

  test("at a phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await settle(page, 200);
    await expect(page).toHaveScreenshot("theatre-mobile.png", { fullPage: true });
  });
});
