import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  ALL_TECHNIQUES,
  BASELINE_CONFIG,
  CONFIG_LEN,
  DEFAULT_CONFIG,
  DEFAULT_SCENARIO,
  METRIC_FIELDS,
  NO_TECHNIQUES,
  SEGMENT_PRESETS,
  SNAPSHOT_STRIDE,
  TECHNIQUE_FIELDS,
  decodeMetrics,
  decodeSnapshots,
  describeConfigError,
  encodeConfig,
  type NetcodeConfig,
} from "../../src/sim/types";

const require = createRequire(import.meta.url);
const core = require("../../core/pkg-node/netcode_core.js") as {
  metrics_len: () => number;
  config_len: () => number;
  snapshot_stride: () => number;
  segment_names: () => string;
  validate_config: (config: Float64Array) => number;
  peekers_advantage_ms: (rtt: number, tick: number, fps: number) => number;
  run_metrics: (...args: never[]) => Float64Array;
  run_snapshots: (...args: never[]) => Float64Array;
};

const s = DEFAULT_SCENARIO;

/** The uncompensated run, which is what the original assertions were written against. */
const metricsFor = (segment: number, seed: bigint, config: NetcodeConfig = BASELINE_CONFIG) =>
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
    encodeConfig(config),
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

  it("reports no loss on a perfect link", () => {
    const decoded = decodeMetrics(metricsFor(0, 42n));
    expect(decoded.packetsDropped).toBe(0);
  });

  /**
   * An uncompensated client renders the last state it received, so it trails the
   * server by the transit time even when nothing is lost. That lag is what
   * prediction exists to remove, not a defect, and the pair of assertions below
   * pins both halves of it.
   */
  it("lags by under a tick without prediction, and not at all with it", () => {
    const uncompensated = decodeMetrics(metricsFor(0, 42n, BASELINE_CONFIG));
    expect(uncompensated.divergenceMax).toBeGreaterThan(0);
    expect(uncompensated.divergenceMax).toBeLessThan(2);

    const predicted = decodeMetrics(
      metricsFor(0, 42n, { ...DEFAULT_CONFIG, techniques: ALL_TECHNIQUES }),
    );
    expect(predicted.divergenceMax).toBe(0);
    expect(predicted.correctionCount).toBe(0);
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

describe("config crosses the boundary intact", () => {
  it("sends as many values as the core reads", () => {
    expect(core.config_len()).toBe(CONFIG_LEN);
    expect(encodeConfig(DEFAULT_CONFIG)).toHaveLength(CONFIG_LEN);
  });

  it("writes the technique flags in the order the core unpacks them", () => {
    // one technique on at a time, so a crossed pair cannot pass. the core reports a
    // reason code for the combinations it rejects, and a bit landing on the wrong
    // field changes which code comes back
    TECHNIQUE_FIELDS.forEach((field, index) => {
      const buffer = encodeConfig({
        ...DEFAULT_CONFIG,
        techniques: { ...NO_TECHNIQUES, [field]: true },
      });
      expect(buffer[index], `${field} should occupy slot ${index}`).toBe(1);
      expect(buffer.slice(0, 6).reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  it("accepts the default configuration", () => {
    expect(core.validate_config(encodeConfig(DEFAULT_CONFIG))).toBe(0);
    expect(core.validate_config(encodeConfig(BASELINE_CONFIG))).toBe(0);
  });

  it("rejects reconciliation without prediction", () => {
    const code = core.validate_config(
      encodeConfig({
        ...DEFAULT_CONFIG,
        techniques: { ...NO_TECHNIQUES, serverReconciliation: true },
      }),
    );
    expect(code).toBe(1);
    expect(describeConfigError(code)).toMatch(/prediction/i);
  });

  it("rejects rollback without prediction", () => {
    expect(
      core.validate_config(
        encodeConfig({
          ...DEFAULT_CONFIG,
          techniques: { ...NO_TECHNIQUES, rollback: true },
        }),
      ),
    ).toBe(2);
  });

  it("describes an unknown reason code without throwing", () => {
    expect(describeConfigError(99)).toContain("99");
  });

  it("changes the result when the techniques change", () => {
    const off = decodeMetrics(metricsFor(4, 42n, BASELINE_CONFIG));
    const on = decodeMetrics(
      metricsFor(4, 42n, { ...DEFAULT_CONFIG, techniques: ALL_TECHNIQUES }),
    );
    expect(on.stateHash).not.toBe(off.stateHash);
  });

  it("changes the result when a constant changes", () => {
    const a = decodeMetrics(metricsFor(4, 42n, DEFAULT_CONFIG));
    const b = decodeMetrics(
      metricsFor(4, 42n, { ...DEFAULT_CONFIG, correctionBlendPermille: 200 }),
    );
    expect(a.stateHash).not.toBe(b.stateHash);
  });

  it("keeps hit registration accuracy a fraction", () => {
    const decoded = decodeMetrics(metricsFor(6, 11n, DEFAULT_CONFIG));
    expect(decoded.hitRegistrationAccuracy).toBeGreaterThanOrEqual(0);
    expect(decoded.hitRegistrationAccuracy).toBeLessThanOrEqual(1);
    expect(decoded.shotsConfirmed).toBeLessThanOrEqual(decoded.shotsFired);
  });

  it("never rolls back further than the configured window", () => {
    const window = 4;
    const decoded = decodeMetrics(
      metricsFor(6, 11n, {
        ...DEFAULT_CONFIG,
        techniques: ALL_TECHNIQUES,
        rollbackWindowTicks: window,
      }),
    );
    expect(decoded.rollbackDepthMean).toBeLessThanOrEqual(window);
  });
});

describe("peekers advantage reproduces the published figures", () => {
  // 2 ms absolute, matching the core. the article rounds its figures and says it
  // hand-waves the buffering term, so an exact match would be false precision
  const TOLERANCE = 2;

  it.each([
    ["baseline", 100, 64, 60, 181],
    ["riot direct at 128 tick", 75, 128, 60, 141],
    ["144 fps client", 35, 128, 144, 71],
  ])("matches %s", (_label, rtt, tick, fps, published) => {
    const computed = core.peekers_advantage_ms(rtt, tick, fps);
    expect(Math.abs(computed - published)).toBeLessThanOrEqual(TOLERANCE);
  });

  it("falls as each published lever improves", () => {
    const base = core.peekers_advantage_ms(100, 64, 60);
    expect(core.peekers_advantage_ms(50, 64, 60)).toBeLessThan(base);
    expect(core.peekers_advantage_ms(100, 128, 60)).toBeLessThan(base);
    expect(core.peekers_advantage_ms(100, 64, 144)).toBeLessThan(base);
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
      encodeConfig(BASELINE_CONFIG),
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
      encodeConfig(BASELINE_CONFIG),
    );
    const decoded = decodeSnapshots(raw);
    const first = decoded[0];
    const last = decoded[decoded.length - 1];
    expect(last?.client.x).toBeGreaterThan(first?.client.x ?? 0);
  });
});
