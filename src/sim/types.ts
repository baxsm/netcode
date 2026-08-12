/**
 * TypeScript mirror of the core's flat boundary.
 *
 * `METRIC_FIELDS` is the single ordered list the decoder derives from, so a field
 * cannot be read at the wrong index. The core's `metrics_len()` is asserted against
 * its length at runtime and in tests, which is what catches a core that added a
 * metric without the mirror following.
 */

export const METRIC_FIELDS = [
  "divergenceMean",
  "divergenceP99",
  "divergenceMax",
  "correctionCount",
  "correctionMagnitudeMean",
  "correctionMagnitudeMax",
  "inputLatencyMeanMs",
  "packetsSent",
  "packetsDropped",
  "sampledTicks",
  "stateHashHigh",
  "stateHashLow",
] as const;

export type MetricField = (typeof METRIC_FIELDS)[number];

export type Metrics = Record<MetricField, number> & {
  /** Reassembled from the two halves, which an f64 cannot carry intact. */
  stateHash: bigint;
};

export const SNAPSHOT_STRIDE = 9;

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Snapshot {
  tick: number;
  server: Body;
  client: Body;
}

export const SEGMENT_PRESETS = [
  "perfect",
  "lan",
  "good broadband",
  "average broadband",
  "mobile 4g",
  "transcontinental",
  "hostile",
] as const;

export type SegmentPreset = (typeof SEGMENT_PRESETS)[number];

export interface ScenarioSpec {
  tickRate: number;
  durationTicks: number;
  accel: number;
  maxSpeed: number;
  frictionPermille: number;
  bounds: number;
  moveFromTick: number;
  stopAtTick: number;
}

export const DEFAULT_SCENARIO: ScenarioSpec = {
  tickRate: 64,
  durationTicks: 400,
  accel: 10,
  maxSpeed: 100,
  frictionPermille: 1000,
  bounds: 1000,
  moveFromTick: 0,
  stopAtTick: 0,
};

export interface CustomSegmentSpec {
  rttMeanMs: number;
  rttJitterMs: number;
  lossPct: number;
  reorderPct: number;
  duplicatePct: number;
  burstLoss: boolean;
}

export function decodeMetrics(buffer: Float64Array | number[]): Metrics {
  if (buffer.length !== METRIC_FIELDS.length) {
    throw new Error(
      `metrics buffer has ${buffer.length} values but the mirror expects ${METRIC_FIELDS.length}`,
    );
  }

  const out = {} as Record<MetricField, number>;
  METRIC_FIELDS.forEach((field, index) => {
    out[field] = buffer[index] as number;
  });

  const high = BigInt(out.stateHashHigh);
  const low = BigInt(out.stateHashLow);
  return { ...out, stateHash: (high << 32n) | low };
}

export function decodeSnapshots(buffer: Float64Array | number[]): Snapshot[] {
  if (buffer.length % SNAPSHOT_STRIDE !== 0) {
    throw new Error(`snapshot buffer of ${buffer.length} is not a whole number of records`);
  }

  const out: Snapshot[] = [];
  for (let i = 0; i < buffer.length; i += SNAPSHOT_STRIDE) {
    out.push({
      tick: buffer[i] as number,
      server: {
        x: buffer[i + 1] as number,
        y: buffer[i + 2] as number,
        vx: buffer[i + 3] as number,
        vy: buffer[i + 4] as number,
      },
      client: {
        x: buffer[i + 5] as number,
        y: buffer[i + 6] as number,
        vx: buffer[i + 7] as number,
        vy: buffer[i + 8] as number,
      },
    });
  }
  return out;
}
