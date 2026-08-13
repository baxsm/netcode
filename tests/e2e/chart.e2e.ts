import { expect, test, type Page } from "@playwright/test";

/**
 * The pareto chart as a person uses it: pointer on a mark, and what happens.
 *
 * This suite exists because the chart shipped broken while every other test passed.
 * Those tests asserted the chart was visible and that its markers existed in the DOM,
 * which was true of a chart whose marks were decoration over a Recharts overlay:
 * hovering a mark did nothing, the readout named the same point forty pixels away in
 * empty space, and 216 configurations drew at 64 distinct pixels so seventy percent of
 * the search could not be seen or clicked at all.
 *
 * So these assert on geometry and on real pointer behaviour rather than on presence.
 */

test.describe.configure({ timeout: 180_000 });

const ready = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/tune");
  await page.getByTestId("run-sweep").click();
  await expect(page.getByTestId("pareto-chart")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(600);
};

/** Every drawn mark, with its centre and how many configurations it stands for. */
const marks = (page: Page) =>
  page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-testid^="point-"]')];
    return nodes.map((n) => {
      const label = n.getAttribute("aria-label") ?? "";
      const group = /(\d+) configurations measured the same/.exec(label);
      return {
        id: n.getAttribute("data-testid") ?? "",
        x: Number(n.getAttribute("cx")),
        y: Number(n.getAttribute("cy")),
        represents: group ? Number(group[1]) : 1,
      };
    });
  });

test("draws every configuration, with none hidden under another", async ({ page }) => {
  await ready(page);
  const drawn = await marks(page);

  // the header's count is the claim, and the marks have to account for all of it
  const header = await page.getByTestId("sweep-size").innerText();
  const configured = Number.parseInt(/(\d+) configurations/.exec(header)?.[1] ?? "0", 10);
  expect(configured).toBeGreaterThan(0);
  expect(drawn.reduce((sum, m) => sum + m.represents, 0)).toBe(configured);
});

/**
 * The failure this is written against: marks at the same pixel, where a click lands on
 * whichever happens to be last in the DOM.
 */
test("keeps every mark far enough from its neighbours to be hit", async ({ page }) => {
  await ready(page);
  const drawn = await marks(page);

  let closest = Infinity;
  for (let i = 0; i < drawn.length; i += 1) {
    for (let j = i + 1; j < drawn.length; j += 1) {
      const a = drawn[i]!;
      const b = drawn[j]!;
      closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  /**
   * Twice the smallest target radius, so two targets can never overlap.
   *
   * Seven pixels rather than a rounder number because that is what the data allows:
   * fourteen marks share the busiest horizontal band and a column is only so wide, so
   * demanding more would mean either hiding marks or letting a column run into its
   * neighbour. The hit radius is derived from this same measured distance at render
   * time, so the two cannot disagree.
   */
  expect(closest, "marks are too close to click apart").toBeGreaterThanOrEqual(7);
});

/**
 * The fan-out is a device for separating marks, not a second measurement.
 *
 * Ranked straight down the value it drew a diagonal inside every column, correlating
 * the horizontal offset with the vertical value at -0.93, so the spread read as a
 * trend that the data does not contain.
 */
test("spreads marks without implying a trend inside a column", async ({ page }) => {
  await ready(page);
  const worst = await page.evaluate(() => {
    const marks = [...document.querySelectorAll('[data-testid^="point-"]')].map((n) => ({
      x: Number(n.getAttribute("cx")),
      y: Number(n.getAttribute("cy")),
    }));
    const columns: Record<string, Array<{ x: number; y: number }>> = {};
    for (const m of marks) {
      const key = String(Math.round(m.x / 200));
      (columns[key] = columns[key] ?? []).push(m);
    }
    const correlations = Object.values(columns)
      .filter((g) => g.length > 3)
      .map((g) => {
        const n = g.length;
        const mx = g.reduce((s, p) => s + p.x, 0) / n;
        const my = g.reduce((s, p) => s + p.y, 0) / n;
        const cov = g.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
        const sx = Math.sqrt(g.reduce((s, p) => s + (p.x - mx) ** 2, 0));
        const sy = Math.sqrt(g.reduce((s, p) => s + (p.y - my) ** 2, 0));
        return Math.abs(cov / (sx * sy));
      });
    return Math.max(...correlations);
  });
  expect(worst, "the horizontal spread must not track the value").toBeLessThan(0.6);
});

test("a mark answers the pointer, and answers for itself", async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId("chart-readout")).toHaveCount(0);

  const drawn = await marks(page);
  const sorted = [...drawn].sort((a, b) => a.x - b.x);
  const left = sorted[Math.floor(sorted.length * 0.25)]!;
  const right = sorted[Math.floor(sorted.length * 0.75)]!;

  const a = page.getByTestId(left.id);
  await a.scrollIntoViewIfNeeded();
  await a.hover();
  await expect(page.getByTestId("chart-readout")).toBeVisible();
  const textA = await page.getByTestId("chart-readout").innerText();

  await page.getByTestId(right.id).hover();
  const textB = await page.getByTestId("chart-readout").innerText();

  // the readout has to follow the mark under the pointer. the overlay it replaced
  // reported one point for a whole column, which is what made it useless
  expect(textA).not.toBe(textB);

  await page.mouse.move(4, 4);
  await expect(page.getByTestId("chart-readout")).toHaveCount(0);
});

test("clicking a mark selects that configuration", async ({ page }) => {
  await ready(page);
  const drawn = await marks(page);
  const target = [...drawn].sort((a, b) => b.x - a.x)[0]!;

  const mark = page.getByTestId(target.id);
  await mark.scrollIntoViewIfNeeded();
  await mark.hover();
  const latency = /Input latency\s*\n?\s*([\d.]+) ms/.exec(
    await page.getByTestId("chart-readout").innerText(),
  )?.[1];

  await mark.click();
  await expect(page.getByTestId("sweep-result")).toBeVisible();
  // the panel must describe the mark that was clicked, not a neighbour
  await expect(page.getByTestId("result-metrics")).toContainText(`${latency} ms`);
});

test("a mark can be reached and chosen from the keyboard", async ({ page }) => {
  await ready(page);
  const drawn = await marks(page);
  const target = [...drawn].sort((a, b) => a.x - b.x)[Math.floor(drawn.length / 2)]!;

  const mark = page.getByTestId(target.id);
  await mark.scrollIntoViewIfNeeded();
  await mark.focus();
  // focus shows the same readout hover does, or a keyboard user is picking blind
  await expect(page.getByTestId("chart-readout")).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sweep-result")).toBeVisible();
});
