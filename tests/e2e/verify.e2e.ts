import { expect, test, type Page } from "@playwright/test";

/**
 * The verification page, driven in a real browser.
 *
 * Every number on this page is measured when it loads, so these check the measured
 * verdicts rather than the layout that holds them. A page that rendered its table
 * while every row failed would pass a render-only test.
 */

test.describe.configure({ timeout: 120_000 });

const ready = async (page: Page) => {
  await page.goto("/#/verify");
  await expect(page.getByTestId("oracle-verdict")).toBeVisible({ timeout: 30_000 });
};

test("reproduces all three published figures", async ({ page }) => {
  await ready(page);

  await expect(page.getByTestId("oracle-row")).toHaveCount(3);
  await expect(page.getByTestId("oracle-verdict")).toHaveText("All three match");

  // the verdict is a word, not a colour, so it is readable without seeing green
  for (const row of await page.getByTestId("oracle-row").all()) {
    await expect(row).toContainText("Pass");
  }
});

/** The tolerance has to be on screen, or a reader cannot judge what "pass" means. */
test("states the tolerance the rows are judged against", async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId("oracle-table")).toContainText("within 2 ms");
});

test("shows one hash per seed and a different hash across seeds", async ({ page }) => {
  await ready(page);

  const verdict = page.getByTestId("determinism-verdict");
  await expect(verdict).toBeVisible({ timeout: 30_000 });
  await expect(verdict).toHaveText("Stable and seed dependent");

  const rows = page.getByTestId("determinism-row");
  await expect(rows).toHaveCount(2);

  const hashes = await rows.locator("code").allInnerTexts();
  expect(new Set(hashes).size, "two seeds must not produce the same hash").toBe(2);
});

test("carries the core build fingerprint next to the hashes", async ({ page }) => {
  await ready(page);
  await expect(page.getByText("relaxed_simd=false").last()).toBeVisible();
});

/**
 * The demos are the page's claim that the effects the tool reports are ones it can
 * actually produce. A demo that stopped reproducing has to say so rather than keep
 * its caption.
 */
test("all three failure modes reproduce", async ({ page }) => {
  await ready(page);

  const demos = page.getByTestId("demo");
  await expect(demos).toHaveCount(3, { timeout: 60_000 });

  for (const demo of await demos.all()) {
    await expect(demo).toContainText("Reproduces");
    await expect(demo).not.toContainText("Did not reproduce");
  }
});

test("a demo opens its broken configuration in the replay", async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId("demo")).toHaveCount(3, { timeout: 60_000 });

  await page.getByTestId("open-hit-registration").click();

  await expect(page.getByTestId("theatre")).toBeVisible({ timeout: 30_000 });
  // the rewind limit is the constant the demo is about, so it has to survive the link
  // and be visible on the strip rather than falling back to the default
  await expect(page.getByTestId("config-strip")).toContainText("rewind limit 40 ms");
  await expect(page.getByTestId("from-sweep")).toBeVisible();
});

test("loads without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await ready(page);
  await expect(page.getByTestId("demo")).toHaveCount(3, { timeout: 60_000 });

  expect(errors).toEqual([]);
});
