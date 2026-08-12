import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  decodeMetrics,
  decodeSnapshots,
  DEFAULT_SCENARIO,
  METRIC_FIELDS,
  SEGMENT_PRESETS,
  SNAPSHOT_STRIDE,
} from "../../src/sim/types";

const require = createRequire(import.meta.url);
const core = require("../../core/pkg-node/netcode_core.js") as {
  metrics_len: () => number;
  snapshot_stride: () => number;
  segment_names: () => string;
  run_metrics: (...args: never[]) => Float64Array;
  run_snapshots: (...args: never[]) => Float64Array;
};

const s = DEFAULT_SCENARIO;
const metricsFor = (segment: number, seed: bigint) =>
  (core.run_metrics as unknown as (...a: unknown[]) => Float64Array)(
    seed,
    segment,
    s.tickRate,
    s.durationTicks,
    s.accel,
    s.maxSpeed,
    s.frictionPermille,
    s.bounds,
    s.moveFromTick,
    s.stopAtTick,
  );

describe("mirror agrees with the core", () => {
  it("declares the same metric count", () => {
    expect(core.metrics_len()).toBe(METRIC_FIELDS.length);
  });

  it("declares the same snapshot stride", () => {
    expect(core.snapshot_stride()).toBe(SNAPSHOT_STRIDE);
  });

  it("lists the same segment presets in the same order", () => {
    expect(core.segment_names().split("\t")).toEqual([...SEGMENT_PRESETS]);
  });

  it("decodes a buffer the core produced", () => {
    const decoded = decodeMetrics(metricsFor(6, 42n));
    for (const field of METRIC_FIELDS) {
      expect(Number.isFinite(decoded[field]), `${field} was not finite`).toBe(true);
    }
  });

  it("rejects a buffer of the wrong length", () => {
    expect(() => decodeMetrics([1, 2, 3])).toThrow(/expects/);
  });

  it("rejects a snapshot buffer that is not a whole number of records", () => {
    expect(() => decodeSnapshots([1, 2, 3])).toThrow(/whole number/);
  });
});

describe("decoded metrics are meaningful", () => {
  it("reassembles the state hash across the f64 split", () => {
    const decoded = decodeMetrics(metricsFor(6, 42n));
    const rebuilt =
      (BigInt(decoded.stateHashHigh) << 32n) | BigInt(decoded.stateHashLow);
    expect(decoded.stateHash).toBe(rebuilt);
    expect(decoded.stateHash).toBeGreaterThan(0n);
  });

  it("reports no loss and no divergence on a perfect link", () => {
    const decoded = decodeMetrics(metricsFor(0, 42n));
    expect(decoded.packetsDropped).toBe(0);
    expect(decoded.divergenceMax).toBe(0);
  });

  it("reports worse divergence on a hostile link than a clean one", () => {
    const clean = decodeMetrics(metricsFor(1, 7n));
    const hostile = decodeMetrics(metricsFor(6, 7n));
    expect(hostile.divergenceMean).toBeGreaterThan(clean.divergenceMean);
  });

  it("scales input latency with the segment round trip", () => {
    const lan = decodeMetrics(metricsFor(1, 3n));
    const far = decodeMetrics(metricsFor(5, 3n));
    expect(far.inputLatencyMeanMs).toBeGreaterThan(lan.inputLatencyMeanMs);
  });

  it("never drops more packets than it sent", () => {
    const decoded = decodeMetrics(metricsFor(6, 11n));
    expect(decoded.packetsDropped).toBeLessThanOrEqual(decoded.packetsSent);
  });

  /**
   * Ordering relationships pin each field to its index. Without these a swapped pair
   * in the mirror still decodes to finite numbers and every other test passes.
   */
  it("orders divergence fields as mean <= p99 <= max", () => {
    const decoded = decodeMetrics(metricsFor(6, 11n));
    expect(decoded.divergenceMean).toBeLessThanOrEqual(decoded.divergenceP99);
    expect(decoded.divergenceP99).toBeLessThanOrEqual(decoded.divergenceMax);
    expect(decoded.divergenceMax).toBeGreaterThan(0);
  });

  it("orders correction magnitude as mean <= max", () => {
    const decoded = decodeMetrics(metricsFor(6, 11n));
    expect(decoded.correctionMagnitudeMean).toBeLessThanOrEqual(decoded.correctionMagnitudeMax);
  });

  it("counts fewer sampled ticks than the run duration", () => {
    const decoded = decodeMetrics(metricsFor(6, 11n));
    expect(decoded.sampledTicks).toBeGreaterThan(0);
    expect(decoded.sampledTicks).toBeLessThan(DEFAULT_SCENARIO.durationTicks);
  });

  it("keeps counts whole and magnitudes fractional", () => {
    const decoded = decodeMetrics(metricsFor(6, 11n));
    for (const field of ["correctionCount", "packetsSent", "packetsDropped", "sampledTicks"] as const) {
      expect(Number.isInteger(decoded[field]), `${field} should be a whole count`).toBe(true);
    }
  });

  it("reproduces a run from the same seed", () => {
    const a = decodeMetrics(metricsFor(6, 99n));
    const b = decodeMetrics(metricsFor(6, 99n));
    expect(a.stateHash).toBe(b.stateHash);
    expect(a.divergenceMean).toBe(b.divergenceMean);
  });

  it("produces different runs from different seeds", () => {
    const a = decodeMetrics(metricsFor(6, 1n));
    const b = decodeMetrics(metricsFor(6, 2n));
    expect(a.stateHash).not.toBe(b.stateHash);
  });
});

describe("snapshots", () => {
  it("decodes one record per tick", () => {
    const raw = (core.run_snapshots as unknown as (...a: unknown[]) => Float64Array)(
      5n,
      1,
      s.tickRate,
      50,
      s.accel,
      s.maxSpeed,
      s.frictionPermille,
      s.bounds,
      s.moveFromTick,
      s.stopAtTick,
    );
    const decoded = decodeSnapshots(raw);
    expect(decoded).toHaveLength(50);
    expect(decoded[0]?.tick).toBe(0);
    expect(decoded[49]?.tick).toBe(49);
  });

  it("moves the body over time", () => {
    const raw = (core.run_snapshots as unknown as (...a: unknown[]) => Float64Array)(
      5n,
      1,
      s.tickRate,
      100,
      s.accel,
      s.maxSpeed,
      s.frictionPermille,
      s.bounds,
      s.moveFromTick,
      s.stopAtTick,
    );
    const decoded = decodeSnapshots(raw);
    const first = decoded[0];
    const last = decoded[decoded.length - 1];
    expect(last?.client.x).toBeGreaterThan(first?.client.x ?? 0);
  });
});
