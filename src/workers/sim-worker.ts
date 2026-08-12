/// <reference lib="webworker" />

import * as Comlink from "comlink";
import init, {
  config_len,
  frame_client_count,
  frame_stride,
  metrics_len,
  peekers_advantage_ms,
  run_frames,
  run_metrics,
  run_metrics_custom,
  run_snapshots,
  validate_config,
  version,
} from "../../core/pkg-web/netcode_core.js";
import {
  CONFIG_LEN,
  FRAME_CLIENT_COUNT,
  FRAME_STRIDE,
  decodeFrames,
  decodeMetrics,
  decodeSnapshots,
  encodeConfig,
  METRIC_FIELDS,
  type CustomSegmentSpec,
  type Frame,
  type Metrics,
  type NetcodeConfig,
  type ScenarioSpec,
  type Snapshot,
} from "../sim/types";

let ready: Promise<void> | null = null;

function load(): Promise<void> {
  if (!ready) {
    ready = init().then(() => {
      const coreLen = metrics_len();
      if (coreLen !== METRIC_FIELDS.length) {
        throw new Error(
          `core reports ${coreLen} metrics but the mirror declares ${METRIC_FIELDS.length}`,
        );
      }
      const coreConfigLen = config_len();
      if (coreConfigLen !== CONFIG_LEN) {
        throw new Error(
          `core reads ${coreConfigLen} config values but the mirror sends ${CONFIG_LEN}`,
        );
      }
      const coreFrameStride = frame_stride();
      if (coreFrameStride !== FRAME_STRIDE) {
        throw new Error(
          `core writes ${coreFrameStride} values per frame but the mirror reads ${FRAME_STRIDE}`,
        );
      }
      const coreClients = frame_client_count();
      if (coreClients !== FRAME_CLIENT_COUNT) {
        throw new Error(
          `core records ${coreClients} clients but the mirror expects ${FRAME_CLIENT_COUNT}`,
        );
      }
    });
  }
  return ready;
}

const api = {
  async version(): Promise<string> {
    await load();
    return version();
  },

  async runOne(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Metrics> {
    await load();
    return decodeMetrics(
      run_metrics(
        seed,
        segmentIndex,
        scenario.tickRate,
        scenario.durationTicks,
        scenario.accel,
        scenario.maxSpeed,
        scenario.frictionPermille,
        scenario.bounds,
        scenario.moveFromTick,
        scenario.stopAtTick,
        encodeConfig(config),
      ),
    );
  },

  async runCustom(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Metrics> {
    await load();
    return decodeMetrics(
      run_metrics_custom(
        seed,
        scenario.tickRate,
        scenario.durationTicks,
        scenario.accel,
        scenario.maxSpeed,
        scenario.frictionPermille,
        scenario.bounds,
        scenario.moveFromTick,
        scenario.stopAtTick,
        segment.rttMeanMs,
        segment.rttJitterMs,
        segment.lossPct,
        segment.reorderPct,
        segment.duplicatePct,
        segment.burstLoss,
        encodeConfig(config),
      ),
    );
  },

  async runSnapshots(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Snapshot[]> {
    await load();
    return decodeSnapshots(
      run_snapshots(
        seed,
        segmentIndex,
        scenario.tickRate,
        scenario.durationTicks,
        scenario.accel,
        scenario.maxSpeed,
        scenario.frictionPermille,
        scenario.bounds,
        scenario.moveFromTick,
        scenario.stopAtTick,
        encodeConfig(config),
      ),
    );
  },

  async runFrames(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Frame[]> {
    await load();
    return decodeFrames(
      run_frames(
        seed,
        scenario.tickRate,
        scenario.durationTicks,
        scenario.accel,
        scenario.maxSpeed,
        scenario.frictionPermille,
        scenario.bounds,
        scenario.moveFromTick,
        scenario.stopAtTick,
        segment.rttMeanMs,
        segment.rttJitterMs,
        segment.lossPct,
        segment.reorderPct,
        segment.duplicatePct,
        segment.burstLoss,
        encodeConfig(config),
      ),
    );
  },

  /** Zero when the configuration is usable, otherwise the core's reason code. */
  async validate(config: NetcodeConfig): Promise<number> {
    await load();
    return validate_config(encodeConfig(config));
  },

  async peekersAdvantage(rttMs: number, tickRate: number, clientFps: number): Promise<number> {
    await load();
    return peekers_advantage_ms(rttMs, tickRate, clientFps);
  },

  async checkDeterminism(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<bigint> {
    const metrics = await api.runOne(scenario, segmentIndex, seed, config);
    return metrics.stateHash;
  },
};

export type SimApi = typeof api;

Comlink.expose(api);
