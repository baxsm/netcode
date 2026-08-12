/**
 * Runs the shared vectors inside the browser and hands the results to Playwright.
 *
 * This page exists only for the determinism gate. The application does not use it.
 */

import init, { state_hash, version } from "../../core/pkg-web/netcode_core.js";
import { VECTORS } from "../vectors";

declare global {
  interface Window {
    determinismResult?: {
      version: string;
      hashes: Record<string, string>;
      error?: string;
    };
    /** Lets a test re-run a single case without reloading the page. */
    hashOnce?: (seed: bigint, ticks: number, entities: number) => string;
  }
}

async function run(): Promise<void> {
  const out = document.getElementById("out");
  try {
    await init();
    const hashes: Record<string, string> = {};
    for (const vector of VECTORS) {
      hashes[vector.name] = state_hash(vector.seed, vector.ticks, vector.entities).toString();
    }
    window.hashOnce = (seed, ticks, entities) => state_hash(seed, ticks, entities).toString();
    window.determinismResult = { version: version(), hashes };
    if (out) out.textContent = JSON.stringify(window.determinismResult, null, 2);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    window.determinismResult = { version: "", hashes: {}, error };
    if (out) out.textContent = `failed: ${error}`;
  }
}

void run();
