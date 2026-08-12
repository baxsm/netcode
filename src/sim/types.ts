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

/** Clients recorded in each replay frame, asserted against the core at load. */
export const FRAME_CLIENT_COUNT = 2;

/** Values per client block inside a frame record. */
export const FRAME_CLIENT_STRIDE = 10;

/** Values per frame: tick, server x/y, rewind target, then one block per client. */
export const FRAME_STRIDE = 4 + FRAME_CLIENT_STRIDE * FRAME_CLIENT_COUNT;

/**
 * What a tick slot carries when it holds nothing.
 *
 * Read only from tick slots. A coordinate has no spare value, so a ghost's presence
 * is decided by its tick and a pre-correction position's by its magnitude, never by
 * the coordinates themselves.
 */
export const ABSENT_TICK = -1;

export interface Point {
  x: number;
  y: number;
}

/** One client on one tick, as the replay view draws it. */
export interface ClientFrame {
  position: Point;
  /** Newest authoritative state this client held, absent before the first arrival. */
  ghost: (Point & { tick: number }) | null;
  /** Where the client was before a correction moved it, absent when none occurred. */
  preCorrection: Point | null;
  correctionMagnitude: number;
  snapped: boolean;
  rollbackDepth: number;
}

export interface Frame {
  tick: number;
  server: Point;
  clients: ClientFrame[];
  /** Tick the server resolved a shot against, absent when nothing was fired. */
  rewindTarget: number | null;
}

/** How each client reads in the interface. Identity is never colour alone. */
export const CLIENT_LABELS = ["Client A", "Client B"] as const;

export function decodeFrames(buffer: Float64Array | number[]): Frame[] {
  if (buffer.length % FRAME_STRIDE !== 0) {
    throw new Error(`frame buffer of ${buffer.length} is not a whole number of records`);
  }

  const out: Frame[] = [];
  for (let i = 0; i < buffer.length; i += FRAME_STRIDE) {
    const rewind = buffer[i + 3] as number;
    const clients: ClientFrame[] = [];

    for (let c = 0; c < FRAME_CLIENT_COUNT; c += 1) {
      const at = i + 4 + c * FRAME_CLIENT_STRIDE;
      const ghostTick = buffer[at + 2] as number;
      const magnitude = buffer[at + 7] as number;
      clients.push({
        position: { x: buffer[at] as number, y: buffer[at + 1] as number },
        ghost:
          ghostTick === ABSENT_TICK
            ? null
            : {
                tick: ghostTick,
                x: buffer[at + 3] as number,
                y: buffer[at + 4] as number,
              },
        preCorrection:
          magnitude > 0 ? { x: buffer[at + 5] as number, y: buffer[at + 6] as number } : null,
        correctionMagnitude: magnitude,
        snapped: buffer[at + 8] === 1,
        rollbackDepth: buffer[at + 9] as number,
      });
    }

    out.push({
      tick: buffer[i] as number,
      server: { x: buffer[i + 1] as number, y: buffer[i + 2] as number },
      clients,
      rewindTarget: rewind === ABSENT_TICK ? null : rewind,
    });
  }
  return out;
}

/**
 * Values per sweep point: a full metrics record, then the two scores and the two
 * halves of the config hash. Asserted against the core's `sweep_stride()` at load.
 */
export const SWEEP_STRIDE = METRIC_FIELDS.length + 4;

/** Values per segment the sweep aggregates over: weight in permille, then conditions. */
export const SWEEP_SEGMENT_STRIDE = 7;

/** One configuration's aggregate result across the whole population. */
export interface SweepPoint {
  config: NetcodeConfig;
  metrics: Metrics;
  /** Lower is better. Input latency and peeker's advantage against fixed anchors. */
  responsiveness: number;
  /** Lower is better. Divergence p99, worst correction and correction rate. */
  smoothness: number;
  configHash: bigint;
}

/**
 * A network segment with its share of the player population.
 *
 * Weight crosses as permille to match every other rate on this boundary, so no
 * decimal is parsed through a float on the way into a fixed-point core.
 */
export interface WeightedSegment extends CustomSegmentSpec {
  weightPermille: number;
}

export function encodeSegments(segments: readonly WeightedSegment[]): Float64Array {
  const out = new Float64Array(segments.length * SWEEP_SEGMENT_STRIDE);
  segments.forEach((s, i) => {
    const at = i * SWEEP_SEGMENT_STRIDE;
    out[at] = s.weightPermille;
    out[at + 1] = s.rttMeanMs;
    out[at + 2] = s.rttJitterMs;
    out[at + 3] = s.lossPct;
    out[at + 4] = s.reorderPct;
    out[at + 5] = s.duplicatePct;
    out[at + 6] = s.burstLoss ? 1 : 0;
  });
  return out;
}

/** Lays configurations end to end, each `CONFIG_LEN` values wide. */
export function encodeConfigs(configs: readonly NetcodeConfig[]): Float64Array {
  const out = new Float64Array(configs.length * CONFIG_LEN);
  configs.forEach((config, i) => out.set(encodeConfig(config), i * CONFIG_LEN));
  return out;
}

/**
 * Reads the sweep buffer back, pairing each record with the config that produced it.
 *
 * The configs are passed in rather than decoded out of the buffer: the core returns
 * a config *hash* for identity, not the fields, so the caller's list is the only
 * place the actual values exist. The hash is what proves the pairing is right.
 */
export function decodeSweep(
  buffer: Float64Array | number[],
  configs: readonly NetcodeConfig[],
): SweepPoint[] {
  if (buffer.length % SWEEP_STRIDE !== 0) {
    throw new Error(`sweep buffer of ${buffer.length} is not a whole number of records`);
  }
  const count = buffer.length / SWEEP_STRIDE;
  if (count !== configs.length) {
    throw new Error(`sweep returned ${count} points for ${configs.length} configurations`);
  }

  const out: SweepPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = i * SWEEP_STRIDE;
    const metrics = decodeMetrics(
      Array.from({ length: METRIC_FIELDS.length }, (_, k) => buffer[at + k] as number),
    );
    const high = BigInt(buffer[at + METRIC_FIELDS.length + 2] as number);
    const low = BigInt(buffer[at + METRIC_FIELDS.length + 3] as number);
    out.push({
      config: configs[i] as NetcodeConfig,
      metrics,
      responsiveness: buffer[at + METRIC_FIELDS.length] as number,
      smoothness: buffer[at + METRIC_FIELDS.length + 1] as number,
      configHash: (high << 32n) | low,
    });
  }
  return out;
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
  inputBufferTicks: 0,
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
