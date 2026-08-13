import { describe, expect, it } from "vitest";
import * as Comlink from "comlink";
import { SimPool, type SpawnSlot } from "../pool";
import type { SimApi } from "../sim-worker";

/**
 * A slot that answers `version()` and nothing else.
 *
 * The pool's scheduling does not care which call is in flight, only that one is, so
 * every test drives it through the cheapest method on the API. Comlink's proxy is
 * replaced wholesale rather than wrapped, because there is no worker underneath.
 */
function fakeSpawn(behaviour: {
  onCall?: (index: number) => Promise<string>;
  terminated?: number[];
}): { spawn: SpawnSlot; spawned: () => number } {
  let spawned = 0;
  const spawn: SpawnSlot = () => {
    const index = spawned++;
    const api = {
      version: () => behaviour.onCall?.(index) ?? Promise.resolve(`worker-${index}`),
      [Comlink.releaseProxy]: () => undefined,
    } as unknown as Comlink.Remote<SimApi>;
    return {
      worker: { terminate: () => behaviour.terminated?.push(index) },
      api,
    };
  };
  return { spawn, spawned: () => spawned };
}

/** Resolves when every queued microtask has run, so in-flight work can settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the worker pool", () => {
  it("reuses a slot rather than spawning per call", async () => {
    const { spawn, spawned } = fakeSpawn({});
    const pool = new SimPool(4, spawn);

    await pool.version();
    await pool.version();
    await pool.version();

    expect(spawned()).toBe(1);
  });

  it("spawns up to the size when calls overlap", async () => {
    const { spawn, spawned } = fakeSpawn({});
    const pool = new SimPool(3, spawn);

    await Promise.all([pool.version(), pool.version(), pool.version()]);

    expect(spawned()).toBe(3);
  });

  /**
   * The cap is the whole point of a pool. Without it a sweep of thousands of runs
   * would spawn a worker per run and each one compiles its own copy of the module.
   */
  it("never exceeds its size, and queues the rest", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<string>((resolve) => {
      release = () => resolve("done");
    });
    const { spawn, spawned } = fakeSpawn({ onCall: () => held });
    const pool = new SimPool(2, spawn);

    const all = Promise.all([pool.version(), pool.version(), pool.version(), pool.version()]);
    await settle();
    expect(spawned()).toBe(2);

    release?.();
    await all;
    expect(spawned()).toBe(2);
  });

  it("hands a freed slot to the next caller in line", async () => {
    const { spawn, spawned } = fakeSpawn({});
    const pool = new SimPool(1, spawn);

    const results = await Promise.all([pool.version(), pool.version()]);

    expect(spawned()).toBe(1);
    expect(results).toEqual(["worker-0", "worker-0"]);
  });
});

describe("a worker that dies mid-run", () => {
  /**
   * A worker that threw may be dead, and handing the same one back would make every
   * retry fail identically against a proxy that is never going to answer.
   */
  it("is terminated and dropped rather than handed back", async () => {
    const terminated: number[] = [];
    const { spawn, spawned } = fakeSpawn({
      onCall: (index) => (index === 0 ? Promise.reject(new Error("worker died")) : Promise.resolve(`worker-${index}`)),
      terminated,
    });
    const pool = new SimPool(2, spawn);

    await expect(pool.version()).rejects.toThrow("worker died");
    expect(terminated).toEqual([0]);

    // the retry gets a live worker rather than the corpse
    await expect(pool.version()).resolves.toBe("worker-1");
    expect(spawned()).toBe(2);
  });

  /**
   * The case the retry path was written for and nothing exercised. A caller queued
   * behind the dead worker must be handed a replacement, not left waiting on a slot
   * that is never coming back.
   */
  it("does not strand a caller queued behind it", async () => {
    let fail: ((cause: Error) => void) | undefined;
    const first = new Promise<string>((_, reject) => {
      fail = reject;
    });
    const { spawn } = fakeSpawn({
      onCall: (index) => (index === 0 ? first : Promise.resolve(`worker-${index}`)),
    });
    const pool = new SimPool(1, spawn);

    const dying = pool.version();
    await settle();
    const queued = pool.version();
    await settle();

    fail?.(new Error("worker died"));

    await expect(dying).rejects.toThrow("worker died");
    await expect(queued).resolves.toBe("worker-1");
  });
});

describe("disposing", () => {
  it("terminates every worker it spawned", async () => {
    const terminated: number[] = [];
    const { spawn } = fakeSpawn({ terminated });
    const pool = new SimPool(3, spawn);

    await Promise.all([pool.version(), pool.version(), pool.version()]);
    pool.dispose();

    expect(terminated.sort()).toEqual([0, 1, 2]);
  });

  /** StrictMode runs cleanup on every mount in development, so this happens for real. */
  it("is safe to call twice", async () => {
    const { spawn } = fakeSpawn({});
    const pool = new SimPool(2, spawn);

    await pool.version();
    pool.dispose();

    expect(() => pool.dispose()).not.toThrow();
  });
});
