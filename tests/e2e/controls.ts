import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Driving the app's controls from a test.
 *
 * The controls are composed widgets rather than bare HTML elements, so `selectOption`
 * and `check` do not apply: a select is a button that opens a listbox, and a switch is
 * a span with `role="switch"`. These helpers are the one place that knows that, so a
 * spec still reads as "pick this option" rather than as a sequence of clicks.
 */

/**
 * Picks an option by its visible text from a composed select.
 *
 * Retried as a whole rather than clicked once. The listbox is portalled and animates
 * in, so a click dispatched the instant it appears can land before it is interactive
 * and leave the popup open with nothing chosen. Asserting the trigger afterwards is
 * what makes the retry meaningful: it fails until the value has actually changed.
 */
export async function choose(trigger: Locator, option: string): Promise<void> {
  const page = trigger.page();
  await expect(async () => {
    if ((await page.getByRole("option").count()) === 0) await trigger.click();
    // the listbox is portalled to the end of the document, so it is addressed from
    // the page rather than from inside the trigger
    await page.getByRole("option", { name: option, exact: true }).click({ timeout: 2_000 });
    await expect(trigger).toContainText(option, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Turns a technique switch on or off, and waits for it to hold. */
export async function setSwitch(control: Locator, on: boolean): Promise<void> {
  const checked = (await control.getAttribute("aria-checked")) === "true";
  if (checked !== on) await control.click();
  await expect(control).toHaveAttribute("aria-checked", String(on));
}

/**
 * Sets a slider to an exact value.
 *
 * The widget still owns a real `input[type=range]`, which is both what a screen reader
 * addresses and the only way to jump to a value without counting arrow presses.
 */
export async function setSlider(
  page: Page,
  testId: string,
  value: number,
): Promise<void> {
  await page
    .getByTestId(testId)
    .locator('input[type="range"]')
    .evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value",
      )?.set;
      setter?.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
}

/** The card a piece of text belongs to, for asserting on a whole panel. */
export function cardWith(page: Page, text: string): Locator {
  return page.locator('[data-slot="card"]', { hasText: text });
}
