/**
 * The cases every engine must agree on.
 *
 * Node and the browsers both read this list, so the two paths cannot drift into
 * testing different things and both reporting green.
 */

export interface Vector {
  readonly name: string;
  readonly seed: bigint;
  readonly ticks: number;
  readonly entities: number;
}

export const VECTORS: readonly Vector[] = [
  { name: "baseline", seed: 42n, ticks: 600, entities: 16 },
  { name: "seed zero", seed: 0n, ticks: 600, entities: 16 },
  { name: "seed max", seed: 18446744073709551615n, ticks: 300, entities: 8 },
  { name: "full arena", seed: 7n, ticks: 1000, entities: 64 },
  { name: "single entity", seed: 99n, ticks: 2000, entities: 1 },
  { name: "zero ticks", seed: 5n, ticks: 0, entities: 4 },
  { name: "long run", seed: 123456789n, ticks: 5000, entities: 32 },
];

/**
 * Hashes captured from the Rust core on the machine that built it. The browsers are
 * checked against these rather than only against each other, so a build where every
 * engine agrees on the wrong answer still fails.
 */
export const EXPECTED: Readonly<Record<string, string>> = {
  baseline: "12437711605233424538",
  "seed zero": "12303115795811892721",
  "seed max": "6045337531062695667",
  "full arena": "371772212692087449",
  "single entity": "7229280520226837599",
  "zero ticks": "7442660319107100209",
  "long run": "9848046739593345173",
};
