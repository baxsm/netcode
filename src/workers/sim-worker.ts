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
  run_sweep,
  scenario_len,
  script_stride,
  sweep_segment_stride,
  sweep_stride,
  validate_config,
  version,
} from "../../core/pkg-web/netcode_core.js";
import {
  CONFIG_LEN,
  FRAME_CLIENT_COUNT,
  FRAME_STRIDE,
  SCENARIO_LEN,
  SCRIPT_STRIDE,
  SWEEP_SEGMENT_STRIDE,
  SWEEP_STRIDE,
  decodeFrames,
  decodeMetrics,
  decodeSnapshots,
  decodeSweep,
  encodeConfig,
  encodeConfigs,
  encodeScenario,
  encodeScript,
  encodeSegments,
  METRIC_FIELDS,
  type CustomSegmentSpec,
  type Frame,
  type InputEventSpec,
  type Metrics,
  type NetcodeConfig,
  type ScenarioSpec,
  type Snapshot,
  type SweepPoint,
  type WeightedSegment,
} from "../sim/types";

/**
 * The script a call sends when the caller has none.
 *
 * Empty means the core runs its built-in move-then-stop shape, which is what every
 * result before authoring was produced by.
 */
const NO_SCRIPT: readonly InputEventSpec[] = [];

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
      const coreSweepStride = sweep_stride();
      if (coreSweepStride !== SWEEP_STRIDE) {
        throw new Error(
          `core writes ${coreSweepStride} values per sweep point but the mirror reads ${SWEEP_STRIDE}`,
        );
      }
      const coreSegmentStride = sweep_segment_stride();
      if (coreSegmentStride !== SWEEP_SEGMENT_STRIDE) {
        throw new Error(
          `core reads ${coreSegmentStride} values per segment but the mirror sends ${SWEEP_SEGMENT_STRIDE}`,
        );
      }
      const coreScenarioLen = scenario_len();
      if (coreScenarioLen !== SCENARIO_LEN) {
        throw new Error(
          `core reads ${coreScenarioLen} scenario values but the mirror sends ${SCENARIO_LEN}`,
        );
      }
      const coreScriptStride = script_stride();
      if (coreScriptStride !== SCRIPT_STRIDE) {
        throw new Error(
          `core reads ${coreScriptStride} values per input event but the mirror sends ${SCRIPT_STRIDE}`,
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
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Metrics> {
    await load();
    return decodeMetrics(
      run_metrics(
        seed,
        segmentIndex,
        encodeScenario(scenario),
        encodeScript(script),
        encodeConfig(config),
      ),
    );
  },

  async runCustom(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Metrics> {
    await load();
    return decodeMetrics(
      run_metrics_custom(
        seed,
        encodeScenario(scenario),
        encodeScript(script),
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
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Snapshot[]> {
    await load();
    return decodeSnapshots(
      run_snapshots(
        seed,
        segmentIndex,
        encodeScenario(scenario),
        encodeScript(script),
        encodeConfig(config),
      ),
    );
  },

  async runFrames(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Frame[]> {
    await load();
    return decodeFrames(
      run_frames(
        seed,
        encodeScenario(scenario),
        encodeScript(script),
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

  /**
   * Runs a block of the configuration grid in one call.
   *
   * The block is many configurations rather than one, because a run costs about
   * 0.4 ms and a round trip to this worker costs about the same. Issued one at a
   * time, a sweep of thousands would spend as long on messaging as on simulating.
   */
  async runSweep(
    scenario: ScenarioSpec,
    configs: NetcodeConfig[],
    segments: WeightedSegment[],
    seeds: number[],
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<SweepPoint[]> {
    await load();
    return decodeSweep(
      run_sweep(
        encodeScenario(scenario),
        encodeScript(script),
        encodeConfigs(configs),
        encodeSegments(segments),
        Float64Array.from(seeds),
      ),
      configs,
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
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<bigint> {
    const metrics = await api.runOne(scenario, segmentIndex, seed, config, script);
    return metrics.stateHash;
  },
};

export type SimApi = typeof api;

Comlink.expose(api);
