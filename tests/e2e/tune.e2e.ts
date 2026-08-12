import { expect, test, type Page } from "@playwright/test";

/**
 * Drives the real sweep: worker pool, batched WASM calls, front computation and the
 * chart. The determinism suite proves the numbers agree with the core; this proves
 * the browser path around them works and that the page says what it did.
 */

/**
 * A sweep is thousands of simulations across a worker pool, and the suite runs many
 * browsers at once, so several sweeps contend for the same cores. Alone a run takes
 * under ten seconds; in parallel it can take several times that. The default 30 s
 * budget is raised rather than the work reduced, because a sweep small enough to fit
 * would stop exercising the batching this page exists to test.
 */
test.describe.configure({ timeout: 180_000 });

const ready = async (page: Page) => {
  await page.goto("/#/tune");
  await expect(page.getByTestId("run-sweep")).toBeVisible({ timeout: 30_000 });
};

const runSweep = async (page: Page) => {
  await page.getByTestId("run-sweep").click();
  await expect(page.getByTestId("front-size")).toBeVisible({ timeout: 60_000 });
};

test("shows the cost of the search before running it", async ({ page }) => {
  await ready(page);

  const size = page.getByTestId("sweep-size");
  await expect(size).toContainText(/\d+ configurations/);
  await expect(size).toContainText(/simulations/);
  // nothing has run yet, so the page must say so rather than showing an empty chart
  await expect(page.getByTestId("sweep-empty")).toBeVisible();
  await expect(page.getByTestId("pareto-chart")).toHaveCount(0);
});

/**
 * A bounded search presenting as a complete one is the failure mode phase 4 names.
 */
test("states that the grid is a sample rather than full coverage", async ({ page }) => {
  await ready(page);
  const note = page.locator(".coverage");
  await expect(note).toContainText("sample of the parameter space");
  await expect(note).toContainText("not an exhaustive search");
});

test("runs a sweep and draws a front", async ({ page }) => {
  await ready(page);
  await runSweep(page);

  await expect(page.getByTestId("pareto-chart")).toBeVisible();
  const front = page.getByTestId("front-size");
  await expect(front).toContainText(/\d+ of \d+ on the front/);

  // every configuration must produce a point, or the front was computed over a
  // subset while still presenting as the whole search
  const size = await page.getByTestId("sweep-size").innerText();
  const configured = Number.parseInt(size.match(/(\d+) configurations/)?.[1] ?? "0", 10);
  const drawn = await page.locator(".chart svg circle").count();
  expect(drawn).toBe(configured);
});

test("selects a point and shows its configuration in player units", async ({ page }) => {
  await ready(page);
  await runSweep(page);

  // the balanced point is selected on completion, so the panel is already populated
  const result = page.getByTestId("sweep-result");
  await expect(result).toBeVisible();
  await expect(page.getByTestId("result-metrics")).toContainText("ms");
  await expect(page.getByTestId("result-config")).toContainText("Input buffer");
  // internal scores are never shown, only quantities a reader can argue about
  await expect(result).not.toContainText("responsiveness score");
});

test("reports the resolution floor rather than implying false precision", async ({ page }) => {
  await ready(page);
  await runSweep(page);
  await expect(page.locator(".panel", { hasText: "The tradeoff" })).toContainText(
    /Differences smaller than 0\.\d+/,
  );
});

test("a second sweep reproduces the first", async ({ page }) => {
  await ready(page);
  await runSweep(page);

  const read = () => page.getByTestId("result-metrics").innerText();
  const before = await read();

  await page.getByTestId("run-sweep").click();
  await expect(page.getByTestId("front-size")).toBeVisible({ timeout: 60_000 });

  expect(await read()).toBe(before);
});

test("changing the population changes the answer", async ({ page }) => {
  await ready(page);
  await runSweep(page);
  const before = await page.getByTestId("result-metrics").innerText();

  await page.locator("#profile").selectOption("competitive");
  await page.getByTestId("run-sweep").click();
  await expect(page.getByTestId("front-size")).toBeVisible({ timeout: 60_000 });

  // a profile that does not reach the result would mean every recommendation is
  // being made against a single latency
  expect(await page.getByTestId("result-metrics").innerText()).not.toBe(before);
});

test("comparing two points shows only what differs", async ({ page }) => {
  await ready(page);
  await runSweep(page);

  const chart = page.getByTestId("pareto-chart");
  await chart.scrollIntoViewIfNeeded();

  /**
   * Two points chosen by their drawn position rather than by index.
   *
   * Configurations that produce the same latency and the same worst correction land
   * on the same pixel, and many do: the chart is 216 points in a handful of columns.
   * Clicking two arbitrary indices can therefore select one configuration twice,
   * which correctly renders as "identical" and fails an assertion about a diff.
   * Picking the leftmost and rightmost drawn positions guarantees two different
   * input buffer depths.
   */
  const boxes = await chart.locator("svg circle").evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
  const sorted = [...boxes].sort((a, b) => a.x - b.x);
  const left = sorted[0];
  const right = sorted[sorted.length - 1];
  expect(left && right && right.x - left.x, "the chart must spread along latency").toBeGreaterThan(
    20,
  );

  /**
   * Dispatched at the point's location rather than driven through `mouse.click`.
   *
   * Recharts binds its handlers to a layer above the markers, and Playwright's
   * synthetic pointer sequence does not reach the shape's own `onClick` through it.
   * The same gesture works in a real browser, verified by hand. Hit-testing the
   * coordinate and firing the sequence at whatever is on top keeps this testing the
   * selection behaviour rather than the driver.
   */
  const clickAt = (point: { x: number; y: number }, shift: boolean) =>
    page.evaluate(
      ({ x, y, shiftKey }) => {
        const target = document.elementFromPoint(x, y);
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          target?.dispatchEvent(
            new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, shiftKey }),
          );
        }
      },
      { x: point.x, y: point.y, shiftKey: shift },
    );

  await clickAt(left as { x: number; y: number }, false);
  await clickAt(right as { x: number; y: number }, true);

  const diff = page.getByTestId("config-diff");
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("Input buffer");
});

test("opens the selected configuration in the replay", async ({ page }) => {
  await ready(page);
  await runSweep(page);

  await page.getByRole("button", { name: "Open in replay" }).click();
  await expect(page).toHaveURL(/buffer=\d+/);
  // the replay has to say it is showing something chosen elsewhere, or the numbers
  // would read as the page default
  await expect(page.getByTestId("from-sweep")).toBeVisible({ timeout: 30_000 });
});

test("exports a config file", async ({ page }) => {
  await ready(page);
  await runSweep(page);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export config" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("netcode-config.json");
});

test("exports a report carrying the front and the seeds", async ({ page }) => {
  await ready(page);
  await runSweep(page);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export report" }).click();
  const file = await download;

  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const report = JSON.parse(Buffer.concat(chunks).toString());

  expect(report.schemaVersion).toBe(1);
  expect(report.seeds.length).toBeGreaterThan(0);
  expect(report.front.length).toBeGreaterThan(0);
  expect(report.chosen.config).toBeTruthy();
  // a result is only meaningful next to the build that produced it
  expect(report.core).toContain("relaxed_simd=false");
  expect(report.profile.segments.length).toBeGreaterThan(1);
});

test("every route in the bar is reachable", async ({ page }) => {
  await ready(page);

  for (const [label, expected] of [
    ["Replay", "Replay"],
    ["Scenarios", "Scenarios"],
    ["Verify", "Verify"],
    ["Tune", "Tune"],
  ] as const) {
    await page.getByRole("navigation").getByRole("link", { name: label }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(expected);
  }
});

/**
 * Every route in the navigation now renders its own surface.
 *
 * This replaces a check that the unbuilt routes said so. Kept rather than deleted,
 * because the property it guards is the same one: a route in the nav must never be a
 * convincing empty page, and the placeholder it used to show must not come back.
 */
test("every route in the navigation is built", async ({ page }) => {
  for (const [path, marker] of [
    ["/#/scenarios", "read-only"],
    ["/#/verify", "oracle-verdict"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId(marker)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("not-built")).toHaveCount(0);
  }
});

test.describe("at the narrow end of the supported range", () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test("the page does not scroll sideways", async ({ page }) => {
    await ready(page);
    await runSweep(page);

    const overflows = await page.evaluate(
      () => document.body.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, "the page itself must not scroll sideways").toBe(false);
  });

  test("the run control stays on screen", async ({ page }) => {
    await ready(page);
    const box = await page.getByTestId("run-sweep").boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(760);
  });
});
