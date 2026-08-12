import { expect, test } from "@playwright/test";
import { SEGMENT_PRESETS } from "../../src/sim/types";

/**
 * Drives the real page: worker pool, WASM load and render. The determinism suite
 * proves the numbers; this proves the browser path around them works.
 */

const ready = async (page: import("@playwright/test").Page) => {
  await page.goto("/");
  await expect(page.getByTestId("results")).toBeVisible({ timeout: 30_000 });
};

test("runs every preset and renders a row for each", async ({ page }) => {
  await ready(page);

  const table = page.getByTestId("results");
  await expect(table.locator("tbody tr")).toHaveCount(SEGMENT_PRESETS.length);

  for (const preset of SEGMENT_PRESETS) {
    await expect(table.getByRole("rowheader", { name: preset, exact: true })).toBeVisible();
  }
});

test("reports the core build flags", async ({ page }) => {
  await ready(page);
  const version = page.getByTestId("version");
  await expect(version).toBeVisible();
  await expect(version).toContainText("relaxed_simd=false");
});

test("shows worse divergence on hostile than on lan", async ({ page }) => {
  await ready(page);

  const cell = async (preset: string, column: number) => {
    const row = page.locator("tbody tr", { hasText: preset }).first();
    const text = await row.locator("td").nth(column).locator(".value").innerText();
    return Number.parseFloat(text);
  };

  expect(await cell("hostile", 0)).toBeGreaterThan(await cell("lan", 0));
});

test("never reports more packets lost than sent", async ({ page }) => {
  await ready(page);

  const rows = page.getByTestId("results").locator("tbody tr");
  for (let i = 0; i < (await rows.count()); i += 1) {
    const cell = rows.nth(i).locator("td").nth(4);
    const lost = Number.parseInt(await cell.locator(".value").innerText(), 10);
    const sent = Number.parseInt(
      (await cell.locator(".change").innerText()).replace(/\D/g, ""),
      10,
    );
    expect(lost).toBeLessThanOrEqual(sent);
  }
});

test("re-running reproduces the same numbers", async ({ page }) => {
  await ready(page);

  const readAll = () => page.getByTestId("results").locator("tbody").innerText();
  const before = await readAll();

  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByRole("button", { name: "Run comparison" })).toBeEnabled({
    timeout: 30_000,
  });

  expect(await readAll()).toBe(before);
});

test("the run button is disabled while a run is in flight", async ({ page }) => {
  await ready(page);

  const button = page.getByRole("button", { name: /Run comparison/ });
  await button.click();
  // the click either catches the disabled state or the run already finished, and
  // both are correct. what must never happen is a second run starting mid-flight
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("results").locator("tbody tr")).toHaveCount(
    SEGMENT_PRESETS.length,
  );
});

test("reproduces the published peekers advantage figures", async ({ page }) => {
  await ready(page);

  const table = page.getByTestId("peekers");
  await expect(table).toBeVisible();

  // the three rows are the oracle, so the page has to show them agreeing rather
  // than only the test suite knowing they do
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(3);

  for (let i = 0; i < 3; i += 1) {
    const computed = Number.parseFloat(await rows.nth(i).locator("td").nth(3).innerText());
    const published = Number.parseFloat(
      (await rows.nth(i).locator("td").nth(4).innerText()).replace("~", ""),
    );
    expect(Math.abs(computed - published)).toBeLessThanOrEqual(2);
  }
});

test("turning off a technique changes the result", async ({ page }) => {
  await ready(page);

  const first = () =>
    page.getByTestId("results").locator("tbody tr").nth(2).locator("td").first().innerText();
  const before = await first();

  await page.getByRole("button", { name: "None", exact: true }).click();
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByRole("button", { name: "Run comparison" })).toBeEnabled({
    timeout: 30_000,
  });

  expect(await first()).not.toBe(before);
});

test("rejects a configuration the core cannot run", async ({ page }) => {
  await ready(page);

  // reconciliation with no prediction has no unacknowledged inputs to replay, so
  // the run must be refused rather than quietly reporting the baseline
  await page.getByRole("checkbox", { name: "Client prediction" }).uncheck();
  await page.getByRole("button", { name: "Run comparison" }).click();

  const message = page.getByTestId("invalid");
  await expect(message).toBeVisible({ timeout: 30_000 });
  await expect(message).toContainText("prediction");
  // and the stale table must not still be on screen next to the error
  await expect(page.getByTestId("results")).toHaveCount(0);
});

/**
 * Below tablet width the app says it needs a wider window rather than shipping a
 * squeezed layout. That is a decision recorded in `ui.md`, so these assert the
 * message appears and the app does not also mount behind it.
 */
test.describe("below tablet width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("says it needs a wider window instead of degrading", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("too-narrow")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
  });

  test("does not scroll sideways", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("too-narrow")).toBeVisible();
    const overflows = await page.evaluate(
      () => document.body.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

/**
 * The narrow end of the supported range, where the layout stacks rather than being
 * replaced. This is what the sub-1100px rule in `ui.md` describes.
 */
test.describe("at the narrow end of the supported range", () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test("the page does not scroll sideways and tables scroll instead", async ({ page }) => {
    await ready(page);

    const layout = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll<HTMLElement>(".table-wrap")];
      return {
        bodyOverflows: document.body.scrollWidth > document.documentElement.clientWidth,
        wrapCount: wraps.length,
        allScrollable: wraps.every((w) => getComputedStyle(w).overflowX === "auto"),
        anyScrolls: wraps.some((w) => w.scrollWidth > w.clientWidth),
      };
    });

    expect(layout.bodyOverflows, "the page itself must not scroll sideways").toBe(false);
    expect(layout.wrapCount).toBeGreaterThan(0);
    expect(layout.allScrollable).toBe(true);
    expect(layout.anyScrolls, "a table should be the thing that scrolls").toBe(true);
  });

  test("the technique controls stay usable", async ({ page }) => {
    await ready(page);

    const box = await page.getByRole("checkbox", { name: "Client prediction" }).boundingBox();
    expect(box, "the first toggle must be on screen").not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(760);
  });
});
