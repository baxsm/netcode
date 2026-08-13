import { expect, test, type Page } from "@playwright/test";
import { choose } from "./controls";

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

  // every configuration must be accounted for, or the front was computed over a
  // subset while still presenting as the whole search. marks can stand for several
  // configurations that measured the same, so they are summed rather than counted
  const size = await page.getByTestId("sweep-size").innerText();
  const configured = Number.parseInt(size.match(/(\d+) configurations/)?.[1] ?? "0", 10);
  const accounted = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="point-"]')].reduce((sum, n) => {
      const group = /(\d+) configurations measured the same/.exec(n.getAttribute("aria-label") ?? "");
      return sum + (group ? Number(group[1]) : 1);
    }, 0),
  );
  expect(accounted).toBe(configured);
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
  await expect(
    page.locator('[data-slot="card"]', { hasText: "The tradeoff" }),
  ).toContainText(/Differences smaller than 0\.\d+/);
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

  await choose(page.locator("#profile"), "Competitive");
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
   * Two marks chosen by drawn position, so they are certainly different
   * configurations rather than two indices that happen to measure the same.
   *
   * Clicked with a real pointer. An earlier version of this test dispatched synthetic
   * events at a coordinate, because the chart's markers were decoration over an
   * overlay that a real click could not reach. That workaround is what let a chart
   * nobody could hover or click pass its own suite.
   */
  const ids = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-testid^="point-"]')];
    const pts = nodes.map((n) => ({
      id: n.getAttribute("data-testid") ?? "",
      x: Number(n.getAttribute("cx")),
    }));
    pts.sort((a, b) => a.x - b.x);
    return [pts[0]?.id ?? "", pts[pts.length - 1]?.id ?? ""];
  });

  await page.getByTestId(ids[0] as string).click();
  await page.getByTestId(ids[1] as string).click({ modifiers: ["Shift"] });

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
