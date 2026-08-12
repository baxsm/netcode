/**
 * Worker pool over the WASM core.
 *
 * Sized to `hardwareConcurrency` because a sweep is embarrassingly parallel: every
 * run is independent, so the only limit is cores. Workers are created once and
 * reused, since spawning one per run would cost more than the run.
 */

import * as Comlink from "comlink";
import type { SimApi } from "./sim-worker";
import type { CustomSegmentSpec, Metrics, ScenarioSpec, Snapshot } from "../sim/types";

export interface SweepProgress {
  completed: number;
  total: number;
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

  runOne(scenario: ScenarioSpec, segmentIndex: number, seed: bigint): Promise<Metrics> {
    return this.withSlot((api) => api.runOne(scenario, segmentIndex, seed));
  }

  runCustom(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
  ): Promise<Metrics> {
    return this.withSlot((api) => api.runCustom(scenario, segment, seed));
  }

  runSnapshots(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
  ): Promise<Snapshot[]> {
    return this.withSlot((api) => api.runSnapshots(scenario, segmentIndex, seed));
  }

  checkDeterminism(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
  ): Promise<bigint> {
    return this.withSlot((api) => api.checkDeterminism(scenario, segmentIndex, seed));
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
        results[index] = await this.runOne(scenario, job.segment, job.seed);
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
