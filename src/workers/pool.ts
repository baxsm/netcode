/**
 * Worker pool over the WASM core.
 *
 * Sized to `hardwareConcurrency` because a sweep is embarrassingly parallel: every
 * run is independent, so the only limit is cores. Workers are created once and
 * reused, since spawning one per run would cost more than the run.
 */

import * as Comlink from "comlink";
import type { SimApi } from "./sim-worker";
import {
  BASELINE_CONFIG,
  type CustomSegmentSpec,
  type Frame,
  type Metrics,
  type NetcodeConfig,
  type ScenarioSpec,
  type Snapshot,
} from "../sim/types";

export interface SweepProgress {
  completed: number;
  total: number;
}

/** One preset measured twice: uncompensated, and with the chosen techniques. */
export interface Comparison {
  segmentIndex: number;
  baseline: Metrics;
  configured: Metrics;
}

interface Slot {
  worker: Worker;
  api: Comlink.Remote<SimApi>;
  busy: boolean;
}

function defaultSize(): number {
  const cores = typeof navigator === "undefined" ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(1, Math.min(cores, 16));
}

export class SimPool {
  private slots: Slot[] = [];
  private waiting: Array<(slot: Slot) => void> = [];

  constructor(private readonly size: number = defaultSize()) {}

  private spawn(): Slot {
    const worker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module" });
    return { worker, api: Comlink.wrap<SimApi>(worker), busy: false };
  }

  private acquire(): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }

    if (this.slots.length < this.size) {
      const slot = this.spawn();
      slot.busy = true;
      this.slots.push(slot);
      return Promise.resolve(slot);
    }

    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(slot: Slot): void {
    const next = this.waiting.shift();
    if (next) {
      next(slot);
      return;
    }
    slot.busy = false;
  }

  private async withSlot<T>(fn: (api: Comlink.Remote<SimApi>) => Promise<T>): Promise<T> {
    const slot = await this.acquire();
    try {
      return await fn(slot.api);
    } finally {
      this.release(slot);
    }
  }

  version(): Promise<string> {
    return this.withSlot((api) => api.version());
  }

  runOne(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Metrics> {
    return this.withSlot((api) => api.runOne(scenario, segmentIndex, seed, config));
  }

  runCustom(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Metrics> {
    return this.withSlot((api) => api.runCustom(scenario, segment, seed, config));
  }

  runSnapshots(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Snapshot[]> {
    return this.withSlot((api) => api.runSnapshots(scenario, segmentIndex, seed, config));
  }

  runFrames(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<Frame[]> {
    return this.withSlot((api) => api.runFrames(scenario, segment, seed, config));
  }

  validate(config: NetcodeConfig): Promise<number> {
    return this.withSlot((api) => api.validate(config));
  }

  peekersAdvantage(rttMs: number, tickRate: number, clientFps: number): Promise<number> {
    return this.withSlot((api) => api.peekersAdvantage(rttMs, tickRate, clientFps));
  }

  checkDeterminism(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
    config: NetcodeConfig,
  ): Promise<bigint> {
    return this.withSlot((api) => api.checkDeterminism(scenario, segmentIndex, seed, config));
  }

  /**
   * Every preset run twice, uncompensated and configured, against the same seed.
   *
   * Pairing the two here rather than in the caller keeps them on the same seed and
   * scenario, which is the only way the difference between them means anything.
   */
  async runComparison(
    scenario: ScenarioSpec,
    segmentIndices: readonly number[],
    seed: bigint,
    config: NetcodeConfig,
    onProgress?: (progress: SweepProgress) => void,
  ): Promise<Comparison[]> {
    const total = segmentIndices.length * 2;
    let completed = 0;

    const step = async <T>(work: Promise<T>): Promise<T> => {
      const value = await work;
      completed += 1;
      onProgress?.({ completed, total });
      return value;
    };

    return Promise.all(
      segmentIndices.map(async (segmentIndex) => {
        const [baseline, configured] = await Promise.all([
          step(this.runOne(scenario, segmentIndex, seed, BASELINE_CONFIG)),
          step(this.runOne(scenario, segmentIndex, seed, config)),
        ]);
        return { segmentIndex, baseline, configured };
      }),
    );
  }

  /**
   * Runs every seed against every segment, reporting progress as results land.
   *
   * Results are written by index rather than pushed, so the order matches the input
   * regardless of which worker finishes first.
   */
  async runMany(
    scenario: ScenarioSpec,
    segmentIndices: readonly number[],
    seeds: readonly bigint[],
    config: NetcodeConfig,
    onProgress?: (progress: SweepProgress) => void,
  ): Promise<Metrics[]> {
    const jobs: Array<{ segment: number; seed: bigint }> = [];
    for (const segment of segmentIndices) {
      for (const seed of seeds) {
        jobs.push({ segment, seed });
      }
    }

    const results = new Array<Metrics>(jobs.length);
    let completed = 0;

    await Promise.all(
      jobs.map(async (job, index) => {
        results[index] = await this.runOne(scenario, job.segment, job.seed, config);
        completed += 1;
        onProgress?.({ completed, total: jobs.length });
      }),
    );

    return results;
  }

  /**
   * Terminates every worker. A pool that is not disposed keeps its threads alive.
   *
   * Safe to call twice: StrictMode runs cleanup on every mount in development, and
   * releasing an already-released proxy throws.
   */
  dispose(): void {
    const slots = this.slots;
    this.slots = [];
    this.waiting = [];
    for (const slot of slots) {
      slot.api[Comlink.releaseProxy]();
      slot.worker.terminate();
    }
  }
}
