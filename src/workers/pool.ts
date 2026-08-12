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
  type InputEventSpec,
  type Metrics,
  type NetcodeConfig,
  type ScenarioSpec,
  type Snapshot,
  type SweepPoint,
  type WeightedSegment,
} from "../sim/types";

/** Empty means the core runs the scenario's built-in move-then-stop script. */
const NO_SCRIPT: readonly InputEventSpec[] = [];

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

/**
 * Workers to run, leaving one core for the thread that draws.
 *
 * A sweep is embarrassingly parallel, so throughput scales with workers, but the last
 * core is worth more to the UI than to the sweep: it is what keeps the progress
 * readout updating while the run is in flight. The cap is a ceiling on machines that
 * report a very high core count, where more workers buy little and each one still
 * compiles its own copy of the module.
 */
function defaultSize(): number {
  const cores = typeof navigator === "undefined" ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(1, Math.min(cores - 1, 12));
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
      const value = await fn(slot.api);
      this.release(slot);
      return value;
    } catch (cause) {
      // a worker that threw may be dead, and handing the same one back would make
      // every retry fail identically. it is discarded and the next acquire spawns a
      // replacement, so a retry gets a live worker
      this.discard(slot);
      throw cause;
    }
  }

  /**
   * Drops a slot from the pool and terminates it.
   *
   * Anything waiting is handed a fresh slot rather than left queued behind a worker
   * that is never coming back.
   */
  private discard(slot: Slot): void {
    const at = this.slots.indexOf(slot);
    if (at !== -1) this.slots.splice(at, 1);

    try {
      slot.worker.terminate();
    } catch {
      // terminating an already-dead worker is not a failure worth reporting
    }

    const next = this.waiting.shift();
    if (next) {
      const replacement = this.spawn();
      replacement.busy = true;
      this.slots.push(replacement);
      next(replacement);
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
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Metrics> {
    return this.withSlot((api) => api.runOne(scenario, segmentIndex, seed, config, script));
  }

  runCustom(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Metrics> {
    return this.withSlot((api) => api.runCustom(scenario, segment, seed, config, script));
  }

  runSnapshots(
    scenario: ScenarioSpec,
    segmentIndex: number,
    seed: bigint,
    config: NetcodeConfig,
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Snapshot[]> {
    return this.withSlot((api) => api.runSnapshots(scenario, segmentIndex, seed, config, script));
  }

  runFrames(
    scenario: ScenarioSpec,
    segment: CustomSegmentSpec,
    seed: bigint,
    config: NetcodeConfig,
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<Frame[]> {
    return this.withSlot((api) => api.runFrames(scenario, segment, seed, config, script));
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
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<bigint> {
    return this.withSlot((api) =>
      api.checkDeterminism(scenario, segmentIndex, seed, config, script),
    );
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
    script: readonly InputEventSpec[] = NO_SCRIPT,
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
          step(this.runOne(scenario, segmentIndex, seed, BASELINE_CONFIG, script)),
          step(this.runOne(scenario, segmentIndex, seed, config, script)),
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
   * Runs the configuration grid across the pool and returns one point per config.
   *
   * The grid is split into chunks and each chunk crosses to a worker in a single
   * call, so the messaging cost is per chunk rather than per run. Results are written
   * back at the index they came from, so the output order matches the input grid no
   * matter which worker finishes first. That ordering is what makes the same sweep
   * produce identical results on 1, 2 or 8 workers.
   */
  async runSweep(
    scenario: ScenarioSpec,
    configs: readonly NetcodeConfig[],
    segments: readonly WeightedSegment[],
    seeds: readonly number[],
    onProgress?: (progress: SweepProgress) => void,
    script: readonly InputEventSpec[] = NO_SCRIPT,
  ): Promise<SweepPoint[]> {
    if (configs.length === 0) return [];

    // enough chunks to keep every worker fed, and small enough that progress moves
    // more than once. a chunk per worker would report nothing until the first
    // finishes, which on a large sweep reads as a hang
    const chunkCount = Math.min(configs.length, Math.max(this.size, 1) * 4);
    const chunkSize = Math.ceil(configs.length / chunkCount);

    const chunks: Array<{ at: number; configs: NetcodeConfig[] }> = [];
    for (let at = 0; at < configs.length; at += chunkSize) {
      chunks.push({ at, configs: configs.slice(at, at + chunkSize) });
    }

    const results = new Array<SweepPoint>(configs.length);
    const seedList = [...seeds];
    const segmentList = [...segments];
    let completed = 0;

    await Promise.all(
      chunks.map(async (chunk) => {
        const points = await this.sweepChunk(
          scenario,
          chunk.configs,
          segmentList,
          seedList,
          script,
        );
        points.forEach((point, i) => {
          results[chunk.at + i] = point;
        });
        completed += chunk.configs.length;
        onProgress?.({ completed, total: configs.length });
      }),
    );

    // a chunk that resolved without filling its slots would leave a hole, and a front
    // computed over a partial grid still looks like a complete answer
    const missing = results.findIndex((point) => point === undefined);
    if (missing !== -1) {
      throw new Error(`the sweep returned no result for configuration ${missing}`);
    }
    return results;
  }

  /**
   * One chunk, retried once on failure.
   *
   * A worker that dies mid-sweep must not have its configurations quietly missing
   * from the results, because the front would then be computed over a subset while
   * still presenting as the whole search. The retry runs on a freshly spawned slot,
   * since the one that died is not going to answer. A second failure names the first
   * configuration in the chunk so the offending input is reported rather than a bare
   * worker error.
   */
  private async sweepChunk(
    scenario: ScenarioSpec,
    configs: NetcodeConfig[],
    segments: WeightedSegment[],
    seeds: number[],
    script: readonly InputEventSpec[],
  ): Promise<SweepPoint[]> {
    const call = (api: Comlink.Remote<SimApi>) =>
      api.runSweep(scenario, configs, segments, seeds, script);
    try {
      return await this.withSlot(call);
    } catch (first) {
      try {
        return await this.withSlot(call);
      } catch (second) {
        const reason = second instanceof Error ? second.message : String(second);
        const first_ = configs[0];
        throw new Error(
          `a worker failed twice on a block of ${configs.length} configurations` +
            `${first_ ? `, starting at interpolation delay ${first_.interpolationDelayTicks}` : ""}: ${reason}`,
          { cause: first },
        );
      }
    }
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
