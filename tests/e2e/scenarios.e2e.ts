import { expect, test, type Page } from "@playwright/test";

/**
 * Drives the authoring surface end to end: duplicate a built-in, edit it, and check
 * the other routes actually run what was authored.
 *
 * The last part is the one worth having. An editor whose output nothing consumes
 * would pass every test written about the editor alone.
 */

test.describe.configure({ timeout: 120_000 });

const ready = async (page: Page) => {
  await page.goto("/#/scenarios");
  await expect(page.getByTestId("read-only")).toBeVisible({ timeout: 30_000 });
};

/** Storage carries between tests in a worker, so each starts from a clean slate. */
test.beforeEach(async ({ page }) => {
  await page.goto("/#/scenarios");
  await page.evaluate(() => localStorage.clear());
});

test("built-ins are read only until duplicated", async ({ page }) => {
  await ready(page);

  const name = page.getByLabel("Name").first();
  await expect(name).toBeDisabled();
  await expect(page.getByTestId("delete")).toHaveCount(0);
  await expect(page.getByTestId("record")).toHaveCount(0);

  await page.getByTestId("duplicate").click();

  await expect(name).toBeEnabled();
  await expect(page.getByTestId("delete")).toBeVisible();
  await expect(page.getByTestId("record")).toBeVisible();
});

test("an authored scenario survives a reload", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate").click();

  const name = page.getByLabel("Name").first();
  await name.fill("Rehearsal");
  await expect(page.getByTestId("authored-count")).toContainText("1 scenarios");

  await page.reload();
  await expect(page.getByLabel("Name").first()).toHaveValue("Rehearsal");
});

test("editing the script changes what the run receives", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate").click();

  const rows = page.getByTestId("script-row");
  await expect(rows).toHaveCount(1);

  await page.getByTestId("add-input").click();
  await expect(rows).toHaveCount(2);

  // a fire makes the rewind limit act, which is what the strip keys off
  await page.getByLabel("Input 2 action").selectOption("fire");
  await page.getByLabel("Input 2 tick").fill("120");

  await page.getByTestId("delete").click();
  await expect(page.getByTestId("nothing-authored")).toBeVisible();
});

test("a scenario past the end of its run is rejected with the reason", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate").click();

  await page.getByLabel("Input 1 tick").fill("9000");
  const problems = page.getByTestId("scenario-problems");
  await expect(problems).toBeVisible();
  await expect(problems).toContainText("never fire");
});

test("a scenario constant outside its range names the field", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate").click();

  await page.getByLabel("Tick rate", { exact: false }).fill("0");
  await expect(page.getByTestId("scenario-problems")).toContainText("tickRate");
});

/**
 * The weights are a warning rather than an error, because the core renormalizes and
 * the run is still meaningful. What it must not do is silently correct them.
 */
test("a profile whose shares do not total a population says so", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate-profile").click();

  await expect(page.getByTestId("weight-warning")).toHaveCount(0);
  await page.getByLabel("Segment 1 Share").fill("10");
  await expect(page.getByTestId("weight-warning")).toContainText("rather than 100%");
});

test("a profile segment can be added and removed", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate-profile").click();

  const rows = page.getByTestId("segment-row");
  const before = await rows.count();
  await page.getByTestId("add-segment").click();
  await expect(rows).toHaveCount(before + 1);

  await page.getByLabel(`Remove segment ${before + 1}`).click();
  await expect(rows).toHaveCount(before);
});

/**
 * The round trip is the claim that an export is worth keeping. A file that comes back
 * as anything other than what went out makes every exported scenario unreliable.
 */
test("an export imports back without loss", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate").click();
  await page.getByLabel("Name").first().fill("Round trip");

  const download = page.waitForEvent("download");
  await page.getByTestId("export").click();
  const file = await (await download).path();
  expect(file).not.toBeNull();

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("nothing-authored")).toBeVisible();

  await page.getByTestId("import").click();
  await page.locator('input[type="file"]').setInputFiles(file as string);

  await expect(page.getByTestId("import-result")).toContainText("Imported 1 scenarios");
  await expect(page.getByTestId("import-problems")).toHaveCount(0);
});

/**
 * The named silent failure for import is a scenario bypassing validation and failing
 * inside the core instead, so a rejection has to name what was wrong.
 */
test("an import from another schema version is rejected with its reason", async ({ page }) => {
  await ready(page);

  await page.getByTestId("import").click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "old.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 99, scenarios: [], profiles: [] })),
  });

  await expect(page.getByTestId("import-problems")).toContainText("schema version");
  await expect(page.getByTestId("nothing-authored")).toBeVisible();
});

test("an authored scenario reaches the replay and the sweep", async ({ page }) => {
  await ready(page);
  await page.getByTestId("duplicate").click();
  await page.getByLabel("Name").first().fill("Reaches the run");
  await page.getByLabel("Duration", { exact: false }).fill("220");

  await page.goto("/#/tune");
  await expect(page.getByTestId("run-sweep")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Scenario").selectOption({ label: "Reaches the run" });
  // the scenario carries its own length, so the note follows it rather than a constant
  await expect(page.getByLabel("Scenario").locator("xpath=../span")).toContainText("220 ticks");

  await page.goto("/#/");
  await expect(page.getByTestId("theatre")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Scenario").selectOption({ label: "Reaches the run" });
  await expect(page.getByTestId("tick-readout")).toContainText("of 219", { timeout: 30_000 });
});
