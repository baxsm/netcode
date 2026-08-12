/// <reference lib="webworker" />

import * as Comlink from "comlink";
import init, {
  config_len,
  metrics_len,
  peekers_advantage_ms,
  run_metrics,
  run_metrics_custom,
  run_snapshots,
  validate_config,
  version,
} from "../../core/pkg-web/netcode_core.js";
import {
  CONFIG_LEN,
  decodeMetrics,
  decodeSnapshots,
  encodeConfig,
  METRIC_FIELDS,
  type CustomSegmentSpec,
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
