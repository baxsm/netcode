import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EXPECTED, VECTORS } from "../vectors";

const require = createRequire(import.meta.url);
const core = require("../../core/pkg-node/netcode_core.js") as {
  state_hash: (seed: bigint, ticks: number, entities: number) => bigint;
  version: () => string;
};

describe("core build", () => {
  it("reports relaxed simd disabled", () => {
    expect(core.version()).toContain("relaxed_simd=false");
  });

  it("reports simd128 disabled", () => {
    expect(core.version()).toContain("simd128=false");
  });
});

describe("determinism in node", () => {
  it.for(VECTORS)("$name matches the recorded hash", (vector) => {
    const got = core.state_hash(vector.seed, vector.ticks, vector.entities);
    expect(got.toString()).toBe(EXPECTED[vector.name]);
  });

  it.for(VECTORS)("$name is stable across repeat calls", (vector) => {
    const first = core.state_hash(vector.seed, vector.ticks, vector.entities);
    const second = core.state_hash(vector.seed, vector.ticks, vector.entities);
    expect(second).toBe(first);
  });

  it("distinguishes adjacent seeds", () => {
    const a = core.state_hash(42n, 600, 16);
    const b = core.state_hash(43n, 600, 16);
    expect(a).not.toBe(b);
  });

  it("distinguishes adjacent tick counts", () => {
    const a = core.state_hash(42n, 600, 16);
    const b = core.state_hash(42n, 601, 16);
    expect(a).not.toBe(b);
  });

  it("carries the full u64 seed range without precision loss", () => {
    const max = 18446744073709551615n;
    const nearMax = max - 1n;
    expect(core.state_hash(max, 300, 8)).not.toBe(core.state_hash(nearMax, 300, 8));
  });
});
