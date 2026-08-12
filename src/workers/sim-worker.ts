/// <reference lib="webworker" />

import * as Comlink from "comlink";
import init, {
  metrics_len,
  run_metrics,
  run_metrics_custom,
  run_snapshots,
  version,
} from "../../core/pkg-web/netcode_core.js";
import {
  decodeMetrics,
  decodeSnapshots,
  METRIC_FIELDS,
  type CustomSegmentSpec,
  type Metrics,
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
    });
  }
  return ready;
}

const api = {
  async version(): Promise<string> {
    await load();
    return version();
  },

  async runOne(scenario: ScenarioSpec, segmentIndex: number, seed: bigint): Promise<Metrics> {
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
      ),
    );
  },

  async runCustom(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
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
      ),
    );
  },

  async runSnapshots(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
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
      ),
    );
  },

  async checkDeterminism(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
  ): Promise<bigint> {
    const metrics = await api.runOne(scenario, segmentIndex, seed);
    return metrics.stateHash;
  },
};

export type SimApi = typeof api;

Comlink.expose(api);
