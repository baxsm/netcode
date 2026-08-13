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

  /**
   * Pause before scrubbing, so the cursor cannot move between the seek and the capture.
   *
   * Clicking once is not enough. The first run lands asynchronously and starts playback
   * when it does, so a pause clicked before that resolves is undone a moment later and
   * the capture then races a moving simulation. That failed roughly one run in three
   * with "failed to take two consecutive stable screenshots", and the diff was the
   * entities and the scrub handle in two different positions.
   *
   * So the pause is asserted to hold rather than to have happened.
   */
  const play = page.getByTestId("play");
  await expect(async () => {
    if ((await play.innerText()) === "Pause") await play.click();
    await expect(play).toHaveText("Play");
    // long enough for a run that landed mid-pause to have restarted playback
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

  // the readout is React state and the canvases are painted in an effect, so hold until
  // the tick has actually stopped moving rather than trusting a single frame
  const readout = page.getByTestId("tick-readout");
  await expect(async () => {
    const first = await readout.innerText();
    await page.waitForTimeout(120);
    expect(await readout.innerText()).toBe(first);
  }).toPass({ timeout: 10_000 });

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

  /**
   * The one baseline that is only a canvas, so it is the one that can be held to the
   * pixel.
   *
   * The default per-pixel threshold is 0.2 in YIQ, which is sized for antialiasing and
   * is far wider than a colour change. Moving client A from blue to cyan scores 0.019
   * against it, so this baseline passed unchanged through a palette change that
   * repainted every entity on it. Entity identity is carried by colour here, which
   * makes a threshold that ignores hue the wrong tool for this frame.
   *
   * The full-page baselines keep the default, since they contain text and would then
   * fail on font rasterisation rather than on anything about the view.
   */
  test("a single view close up", async ({ page }) => {
    await settle(page, 200);
    await expect(page.getByTestId("view-A")).toHaveScreenshot("view-a-tick-200.png", {
      threshold: 0,
      maxDiffPixels: 0,
    });
  });

  /** The narrow end of the supported range, where the three views stack. */
  test("at the narrow end of the supported range", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await settle(page, 200);
    await expect(page).toHaveScreenshot("theatre-narrow.png", { fullPage: true });
  });

  /** Below tablet the app is replaced by a message, so that is what gets pinned. */
  test("below tablet width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await expect(page.getByTestId("too-narrow")).toBeVisible();
    await expect(page).toHaveScreenshot("too-narrow.png", { fullPage: true });
  });

  /**
   * The sweep is as deterministic as the replay, so its chart is a stable baseline
   * too. The selected point is chosen by the code rather than by a click, which keeps
   * the capture independent of where a marker happens to land.
   */
  test("the tune page before a sweep", async ({ page }) => {
    await page.goto("/#/tune");
    await expect(page.getByTestId("sweep-empty")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveScreenshot("tune-empty.png", { clip: TOP });
  });

  test("the pareto front", async ({ page }) => {
    await page.goto("/#/tune");
    await page.getByTestId("run-sweep").click();
    await expect(page.getByTestId("front-size")).toBeVisible({ timeout: 60_000 });

    // the elapsed time is in the heading and changes every run, so it is masked
    // rather than left to fail a baseline for a reason that is not visual
    await expect(page).toHaveScreenshot("tune-front.png", {
      fullPage: true,
      mask: [page.getByTestId("front-size")],
    });
  });

  test("the scenarios page", async ({ page }) => {
    await page.goto("/#/scenarios");
    await expect(page.getByTestId("read-only")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveScreenshot("scenarios.png", { fullPage: true });
  });

  /**
   * Captured after every check has settled, since the point of the page is the
   * verdicts rather than the layout that holds them.
   *
   * A verdict appears as soon as its own section resolves, and the three sections
   * measure independently, so waiting on the verdicts alone can capture while another
   * section is still a one-line "running" state. Waiting for every loading state to be
   * gone is the condition that actually means idle.
   */
  test("the verification page", async ({ page }) => {
    await page.goto("/#/verify");
    await expect(page.getByTestId("oracle-verdict")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("determinism-verdict")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("demo-list")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid$="-loading"]')).toHaveCount(0, { timeout: 60_000 });

    /**
     * Held until nothing on the page is still animating.
     *
     * Every section measures independently and the verdicts land at different moments,
     * so "no loading state left" is necessary but not sufficient: a badge can still be
     * part-way through its transition when the last one resolves. Under a parallel run
     * that window is wide enough to capture, and it failed roughly one run in ten that
     * way while passing every time on its own.
     */
    await page.waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== "running"),
      undefined,
      { timeout: 10_000 },
    );
    await expect(page).toHaveScreenshot("verify.png", { fullPage: true });
  });
});
