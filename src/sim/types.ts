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
  "rollbackCount",
  "rollbackDepthMean",
  "snapCount",
  "hitRegistrationAccuracy",
  "shotsFired",
  "shotsConfirmed",
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

export const TECHNIQUE_FIELDS = [
  "clientPrediction",
  "serverReconciliation",
  "entityInterpolation",
  "extrapolation",
  "serverRewind",
  "rollback",
] as const;

export type TechniqueField = (typeof TECHNIQUE_FIELDS)[number];
export type TechniqueSet = Record<TechniqueField, boolean>;

/** How each technique reads in the interface, in the same order as the flags. */
export const TECHNIQUE_LABELS: Record<TechniqueField, string> = {
  clientPrediction: "Client prediction",
  serverReconciliation: "Server reconciliation",
  entityInterpolation: "Entity interpolation",
  extrapolation: "Extrapolation",
  serverRewind: "Server rewind",
  rollback: "Rollback",
};

/**
 * The tuning constants, in the order the core's `config_from_buffer` reads them.
 *
 * Rates and thresholds cross as permille integers rather than decimals, because the
 * core is fixed point and parsing a decimal on the way in would route a float into
 * the one place floats are banned.
 */
export interface NetcodeConfig {
  techniques: TechniqueSet;
  interpolationDelayTicks: number;
  inputBufferTicks: number;
  rollbackWindowTicks: number;
  correctionBlendPermille: number;
  snapThresholdPermille: number;
  serverRewindLimitMs: number;
  extrapolationLimitTicks: number;
}

export const CONFIG_LEN = 13;

export const NO_TECHNIQUES: TechniqueSet = {
  clientPrediction: false,
  serverReconciliation: false,
  entityInterpolation: false,
  extrapolation: false,
  serverRewind: false,
  rollback: false,
};

export const ALL_TECHNIQUES: TechniqueSet = {
  clientPrediction: true,
  serverReconciliation: true,
  entityInterpolation: true,
  extrapolation: true,
  serverRewind: true,
  rollback: true,
};

/** Matches `NetcodeConfig::default()` in the core. */
export const DEFAULT_CONFIG: NetcodeConfig = {
  techniques: ALL_TECHNIQUES,
  interpolationDelayTicks: 2,
  inputBufferTicks: 2,
  rollbackWindowTicks: 8,
  correctionBlendPermille: 800,
  snapThresholdPermille: 50_000,
  serverRewindLimitMs: 200,
  extrapolationLimitTicks: 6,
};

/** The uncompensated run every comparison is measured against. */
export const BASELINE_CONFIG: NetcodeConfig = {
  ...DEFAULT_CONFIG,
  techniques: NO_TECHNIQUES,
};

/**
 * Flattens a config into the buffer the core reads.
 *
 * Built from `TECHNIQUE_FIELDS` rather than by listing the flags again, so a flag
 * cannot be written at the wrong index. `encodeConfigMatchesCoreLength` asserts the
 * result against the core's own `config_len()`.
 */
export function encodeConfig(config: NetcodeConfig): Float64Array {
  const out = new Float64Array(CONFIG_LEN);
  TECHNIQUE_FIELDS.forEach((field, index) => {
    out[index] = config.techniques[field] ? 1 : 0;
  });
  out[6] = config.interpolationDelayTicks;
  out[7] = config.inputBufferTicks;
  out[8] = config.rollbackWindowTicks;
  out[9] = config.correctionBlendPermille;
  out[10] = config.snapThresholdPermille;
  out[11] = config.serverRewindLimitMs;
  out[12] = config.extrapolationLimitTicks;
  return out;
}

/** Reason codes returned by the core's `validate_config`. */
export const CONFIG_ERRORS: Record<number, string> = {
  1: "Reconciliation needs client prediction, since it replays predicted inputs.",
  2: "Rollback needs client prediction, since it resimulates predicted history.",
  3: "Interpolation delay is deeper than the state buffer that feeds it.",
  4: "A blend rate of 1000 never converges on the server.",
  5: "Server rewind needs a limit above zero.",
};

export function describeConfigError(code: number): string {
  return CONFIG_ERRORS[code] ?? `Configuration rejected with code ${code}.`;
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
