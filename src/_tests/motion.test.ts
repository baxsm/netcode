import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet is read as text rather than exercised in a browser, because the
 * property being asserted is a rule about how the CSS is written. jsdom has no
 * animation clock to freeze, and the real failure only appears in a browser tab that
 * is not in front, which is not a state a unit test can enter.
 */
const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Every `@keyframes name { ... }` block, as [name, body]. */
function keyframeBlocks(css: string): Array<[string, string]> {
  const blocks: Array<[string, string]> = [];
  const opener = /@keyframes\s+([\w-]+)\s*\{/g;
  let match = opener.exec(css);
  while (match) {
    // walk braces from the opening one, so nested keyframe selectors close correctly
    let depth = 1;
    let i = opener.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push([match[1] as string, css.slice(opener.lastIndex, i - 1)]);
    match = opener.exec(css);
  }
  return blocks;
}

describe("entry animations", () => {
  /**
   * Chrome freezes the animation clock in a tab that is not in front, and an animation
   * whose clock never starts holds its element on the first keyframe. Every fill mode
   * behaves that way, so an entry animation declaring `from { opacity: 0 }` renders its
   * element invisible for as long as the tab stays in the background.
   *
   * This shipped once: loading any route in a background tab showed a blank page. The
   * fix is that entry keyframes move rather than fade, and this is the guard on it.
   *
   * A keyframe that only ever raises opacity is fine, which is why the assertion is
   * about the starting value rather than about the property appearing at all.
   */
  it("never starts an entry keyframe from a hidden state", () => {
    const offenders: string[] = [];

    for (const [name, body] of keyframeBlocks(CSS)) {
      // the entry state is whichever of these the block declares
      const from = /(?:^|[},])\s*(?:from|0%)\s*\{([^}]*)\}/.exec(body);
      if (!from) continue;
      const opacity = /opacity:\s*([\d.]+)/.exec(from[1] as string);
      if (opacity && Number.parseFloat(opacity[1] as string) < 1) {
        offenders.push(`${name} starts at opacity ${opacity[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The simulation is the content rather than decoration around it, so reducing motion
   * must not stop it. `ui.md` states this and the canvas is the surface it protects.
   */
  it("leaves the simulation canvas out of every animation rule", () => {
    const reduced = /@media\s*\(prefers-reduced-motion[^)]*\)\s*\{/.test(CSS);
    expect(reduced).toBe(true);
    expect(/\.view canvas[^{]*\{[^}]*animation:/.test(CSS)).toBe(false);
  });
});
