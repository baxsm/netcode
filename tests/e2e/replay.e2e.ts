import { expect, test, type Page } from "@playwright/test";

/**
 * The replay theatre in a real browser.
 *
 * Everything here goes through the worker pool and the WASM core, so a failure means
 * the browser path is broken rather than the arithmetic. The visual checks live in
 * `screenshots.e2e.ts`.
 */

const ready = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByTestId("theatre")).toBeVisible({ timeout: 30_000 });
  // the first run has to finish before the transport does anything
  await expect(page.getByTestId("tick-readout")).toContainText("of 399", { timeout: 30_000 });
};

const tickOf = async (page: Page): Promise<number> => {
  const text = await page.getByTestId("tick-readout").innerText();
  return Number.parseInt(text.replace(/^tick /, ""), 10);
};

const setRange = async (page: Page, testId: string, value: number) => {
  await page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )?.set;
    setter?.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
};

/** The landing route must open already running, not waiting to be configured. */
test("opens with a simulation already playing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("theatre")).toBeVisible({ timeout: 30_000 });

  // the button reads Pause only while it is playing, which it must be on arrival
  await expect(page.getByTestId("play")).toHaveText("Pause", { timeout: 30_000 });

  const first = await tickOf(page);
  await page.waitForTimeout(400);
  expect(await tickOf(page)).toBeGreaterThan(first);
});

test("renders all three views", async ({ page }) => {
  await ready(page);
  for (const glyph of ["S", "A", "B"]) {
    await expect(page.getByTestId(`view-${glyph}`)).toBeVisible();
  }
});

/**
 * The three views share one cursor, so they must always be drawn for the same tick.
 * Independent cursors would drift and the panels would stop being comparable, which is
 * this screen's documented failure mode.
 */
test("labels every view with the same tick", async ({ page }) => {
  await ready(page);
  await page.getByTestId("play").click();

  const tick = await tickOf(page);
  for (const glyph of ["S", "A", "B"]) {
    await expect(page.getByTestId(`view-${glyph}`)).toHaveAttribute(
      "aria-label",
      new RegExp(`tick ${tick}$`),
    );
  }
});

test("pauses and resumes", async ({ page }) => {
  await ready(page);

  await page.getByTestId("play").click();
  await expect(page.getByTestId("play")).toHaveText("Play");

  const held = await tickOf(page);
  await page.waitForTimeout(400);
  expect(await tickOf(page)).toBe(held);

  await page.getByTestId("play").click();
  await expect(page.getByTestId("play")).toHaveText("Pause");
  await page.waitForTimeout(400);
  expect(await tickOf(page)).toBeGreaterThan(held);
});

/** Stepping has to be exact, because it is what makes rollback comprehensible. */
test("steps exactly one tick in each direction", async ({ page }) => {
  await ready(page);
  await setRange(page, "scrub", 100);
  expect(await tickOf(page)).toBe(100);

  await page.getByTestId("step-forward").click();
  expect(await tickOf(page)).toBe(101);

  await page.getByTestId("step-back").click();
  expect(await tickOf(page)).toBe(100);
});

test("scrubs to the requested tick", async ({ page }) => {
  await ready(page);
  for (const tick of [0, 57, 200, 399]) {
    await setRange(page, "scrub", tick);
    expect(await tickOf(page)).toBe(tick);
  }
});

test("stops stepping at both ends", async ({ page }) => {
  await ready(page);

  await setRange(page, "scrub", 0);
  await expect(page.getByTestId("step-back")).toBeDisabled();

  await setRange(page, "scrub", 399);
  await expect(page.getByTestId("step-forward")).toBeDisabled();
});

/**
 * Changing a condition must re-run rather than redraw. A higher round trip leaves the
 * client further behind the server, which is the whole reason the sliders exist.
 */
test("a higher round trip leaves the client further behind", async ({ page }) => {
  await ready(page);

  const gapAt = async (rtt: number): Promise<number> => {
    await setRange(page, "condition-rttMeanMs", rtt);
    await expect(page.getByTestId("tick-readout")).toContainText("of 399", { timeout: 30_000 });
    await setRange(page, "scrub", 200);
    const text = await page.getByTestId("frame-readout").locator("dd").nth(2).innerText();
    return Number.parseFloat(text);
  };

  const near = await gapAt(20);
  const far = await gapAt(400);
  expect(far).toBeGreaterThan(near);
});

/** The same seed must reproduce the run exactly, through the whole browser stack. */
test("reproduces a run from the same seed", async ({ page }) => {
  await ready(page);

  const readAt = async (seed: string): Promise<string> => {
    await page.getByTestId("seed").fill(seed);
    await expect(page.getByTestId("tick-readout")).toContainText("of 399", { timeout: 30_000 });
    await setRange(page, "scrub", 250);
    return page.getByTestId("frame-readout").locator("dd").nth(2).innerText();
  };

  const first = await readAt("42");
  const other = await readAt("99");
  const again = await readAt("42");

  expect(again).toBe(first);
  expect(other).not.toBe(first);
});

test("shows the active configuration", async ({ page }) => {
  await ready(page);
  const strip = page.getByTestId("config-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("Client prediction");
  await expect(strip).toContainText("rollback window");
});

test("explains every marker it draws", async ({ page }) => {
  await ready(page);
  const legend = page.getByTestId("legend");
  await expect(legend).toContainText("Correction");
  await expect(legend).toContainText("Rollback");
  await expect(legend).toContainText("Rewind target");
});

/**
 * The backing store must match the device pixel ratio, otherwise every screenshot of
 * the project is soft on a high-DPI display.
 */
test("sizes the canvas to the device pixel ratio", async ({ page }) => {
  await ready(page);

  const sizes = await page.getByTestId("view-A").evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return {
      backing: canvas.width,
      css: rect.width,
      dpr: window.devicePixelRatio,
    };
  });

  expect(sizes.backing).toBe(Math.round(sizes.css * sizes.dpr));
});

test("carries view identity in more than colour", async ({ page }) => {
  await ready(page);
  // the glyph and the title both survive greyscale, so neither depends on the swatch
  for (const [glyph, title] of [
    ["S", "Server truth"],
    ["A", "Client A"],
    ["B", "Client B"],
  ]) {
    await expect(page.getByTestId(`view-${glyph}`)).toHaveAttribute(
      "aria-label",
      new RegExp(`^${title},`),
    );
  }
});

test("runs without a console error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await ready(page);
  await setRange(page, "scrub", 300);
  await page.getByTestId("step-forward").click();

  expect(errors).toEqual([]);
});

test.describe("at a phone width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("stacks the views without overflowing the page", async ({ page }) => {
    await ready(page);

    for (const glyph of ["S", "A", "B"]) {
      await expect(page.getByTestId(`view-${glyph}`)).toBeVisible();
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  test("keeps the transport usable", async ({ page }) => {
    await ready(page);
    await expect(page.getByTestId("play")).toBeVisible();
    await setRange(page, "scrub", 120);
    expect(await tickOf(page)).toBe(120);
    await page.getByTestId("step-forward").click();
    expect(await tickOf(page)).toBe(121);
  });
});
