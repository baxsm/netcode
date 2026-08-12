/**
 * The working set of scenarios and profiles, held in `localStorage`.
 *
 * There is no backend, so this is the whole persistence layer. Built-ins are code
 * rather than stored rows: shipping them as seeded storage would let a user edit one
 * into something the tests still claim to cover, and a cleared browser would then
 * come back with a different set of built-ins than the one the app was verified
 * against.
 */

import {
  DEFAULT_SCENARIO,
  builtInScript,
  type InputEventSpec,
  type ScenarioSpec,
  // explicit extensions so the baseline runner, which executes under plain Node
  // rather than through Vite, can resolve this chain
} from "../sim/types.ts";
import { PROFILES, type NetworkProfile } from "../sweep/profiles.ts";

/**
 * Bumped when a stored shape changes in a way an older file cannot describe.
 *
 * Import checks it rather than trusting the fields it happens to find, because a file
 * missing a field that later became meaningful would otherwise load with a default
 * nobody chose and run as though it had been authored that way.
 */
export const SCHEMA_VERSION = 1;

const STORAGE_KEY = "netcode.authored.v1";

export interface AuthoredScenario {
  id: string;
  name: string;
  spec: ScenarioSpec;
  script: InputEventSpec[];
}

export interface Authored {
  scenarios: AuthoredScenario[];
  profiles: NetworkProfile[];
  /**
   * What was being edited when the page was last open.
   *
   * Stored because reloading mid-edit and landing back on the first built-in loses
   * your place in the one surface where you are most likely to reload.
   */
  editing?: { scenarioId?: string; profileId?: string };
}

/**
 * The scenarios that ship with the app.
 *
 * `peekers` and `hitreg` fire shots, which is what makes the server rewind limit a
 * constant with an effect rather than one the sweep would report as inert. Phase 4
 * held it out of the search for exactly that reason.
 */
export const BUILT_IN_SCENARIOS: AuthoredScenario[] = [
  {
    id: "drift",
    name: "Straight-line drift",
    spec: DEFAULT_SCENARIO,
    script: builtInScript(DEFAULT_SCENARIO),
  },
  {
    id: "stop-start",
    name: "Stop and start",
    spec: { ...DEFAULT_SCENARIO, moveFromTick: 0, stopAtTick: 180 },
    script: [
      { tick: 0, action: "move", dxPermille: 1000, dyPermille: 0 },
      { tick: 120, action: "move", dxPermille: -1000, dyPermille: 0 },
      { tick: 180, action: "stop", dxPermille: 0, dyPermille: 0 },
      { tick: 260, action: "move", dxPermille: 0, dyPermille: 1000 },
    ],
  },
  {
    id: "peekers",
    name: "Peeker's duel",
    spec: { ...DEFAULT_SCENARIO, durationTicks: 320 },
    script: [
      { tick: 0, action: "move", dxPermille: 1000, dyPermille: 0 },
      { tick: 90, action: "move", dxPermille: 0, dyPermille: 1000 },
      { tick: 140, action: "fire", dxPermille: 1000, dyPermille: 0 },
      { tick: 200, action: "move", dxPermille: -1000, dyPermille: 0 },
      { tick: 240, action: "fire", dxPermille: -1000, dyPermille: 0 },
    ],
  },
  {
    id: "hitreg",
    name: "Repeated fire",
    spec: { ...DEFAULT_SCENARIO, durationTicks: 400 },
    // a shot every twenty ticks past the warmup, so hit registration is measured over
    // a run of them rather than reported from a single outcome
    script: [
      { tick: 0, action: "move", dxPermille: 1000, dyPermille: 0 },
      ...Array.from({ length: 16 }, (_, i) => ({
        tick: 60 + i * 20,
        action: "fire" as const,
        dxPermille: 1000,
        dyPermille: 0,
      })),
    ],
  },
];

export function isBuiltInScenario(id: string): boolean {
  return BUILT_IN_SCENARIOS.some((s) => s.id === id);
}

export function isBuiltInProfile(id: string): boolean {
  return PROFILES.some((p) => p.id === id);
}

export const EMPTY: Authored = { scenarios: [], profiles: [] };

/** Limits that keep an authored scenario inside what the core will accept. */
export const LIMITS = {
  tickRate: { min: 1, max: 512 },
  durationTicks: { min: 1, max: 4000 },
  accel: { min: 0, max: 1000 },
  maxSpeed: { min: 1, max: 10_000 },
  frictionPermille: { min: 0, max: 1000 },
  bounds: { min: 1, max: 100_000 },
} as const;

export type LimitedField = keyof typeof LIMITS;

/**
 * Why a scenario was rejected, one message per problem.
 *
 * Every message names the field, because the failure this guards against is an
 * imported scenario reaching the core and failing there in terms of a buffer index
 * rather than of the thing the user typed.
 */
export function validateScenario(scenario: AuthoredScenario): string[] {
  const problems: string[] = [];

  if (!scenario.id.trim()) problems.push("The scenario needs an id.");
  if (!scenario.name.trim()) problems.push("The scenario needs a name.");

  for (const field of Object.keys(LIMITS) as LimitedField[]) {
    const value = scenario.spec[field];
    const { min, max } = LIMITS[field];
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      problems.push(`${field} must be a whole number.`);
    } else if (value < min || value > max) {
      problems.push(`${field} must be between ${min} and ${max}.`);
    }
  }

  scenario.script.forEach((event, i) => {
    const at = `Input ${i + 1}`;
    if (!Number.isInteger(event.tick) || event.tick < 0) {
      problems.push(`${at} needs a whole tick at or above zero.`);
    } else if (event.tick >= scenario.spec.durationTicks) {
      problems.push(
        `${at} is at tick ${event.tick}, past the ${scenario.spec.durationTicks} tick run, so it would never fire.`,
      );
    }
    for (const axis of ["dxPermille", "dyPermille"] as const) {
      const value = event[axis];
      if (!Number.isInteger(value) || value < -1000 || value > 1000) {
        problems.push(`${at} needs ${axis} between -1000 and 1000.`);
      }
    }
  });

  return problems;
}

export function validateProfile(profile: NetworkProfile): string[] {
  const problems: string[] = [];

  if (!profile.id.trim()) problems.push("The profile needs an id.");
  if (!profile.name.trim()) problems.push("The profile needs a name.");
  if (profile.segments.length === 0) problems.push("A profile needs at least one segment.");

  profile.segments.forEach((segment, i) => {
    const at = `Segment ${i + 1}`;
    if (!Number.isInteger(segment.weightPermille) || segment.weightPermille <= 0) {
      problems.push(`${at} needs a weight above zero.`);
    }
    if (segment.rttMeanMs < 0 || segment.rttMeanMs > 60_000) {
      problems.push(`${at} needs a round trip between 0 and 60000 ms.`);
    }
    if (segment.rttJitterMs < 0 || segment.rttJitterMs > 60_000) {
      problems.push(`${at} needs jitter between 0 and 60000 ms.`);
    }
    for (const rate of ["lossPct", "reorderPct", "duplicatePct"] as const) {
      const value = segment[rate];
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        problems.push(`${at} needs ${rate} between 0 and 100.`);
      }
    }
  });

  return problems;
}

/**
 * Reads the working set, dropping anything that no longer validates.
 *
 * A stored scenario that fails validation is discarded rather than repaired. Repairing
 * it would run something the user never authored, and the fields it would need are
 * exactly the ones that failed.
 */
export function load(storage: Storage | null = safeStorage()): Authored {
  if (!storage) return EMPTY;

  let parsed: unknown;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    parsed = JSON.parse(raw);
  } catch {
    // unreadable storage is the same as none, and throwing here would take down
    // every route rather than the one authored scenario that was malformed
    return EMPTY;
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) return EMPTY;

  const editing = isRecord(parsed.editing) ? parsed.editing : {};
  return {
    scenarios: asArray(parsed.scenarios)
      .filter(isScenarioShaped)
      .filter((s) => validateScenario(s).length === 0),
    profiles: asArray(parsed.profiles)
      .filter(isProfileShaped)
      .filter((p) => validateProfile(p).length === 0),
    editing: {
      ...(typeof editing.scenarioId === "string" ? { scenarioId: editing.scenarioId } : {}),
      ...(typeof editing.profileId === "string" ? { profileId: editing.profileId } : {}),
    },
  };
}

export function save(value: Authored, storage: Storage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...value }));
  } catch {
    // a full or blocked quota must not take down the editor the user is typing into
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Shape checks that run before validation.
 *
 * Validation reads fields and reports on their values, so it needs the fields to
 * exist first. A file with a string where a number belongs would otherwise reach the
 * range checks and pass, because a comparison against a string is simply false.
 */
function isScenarioShaped(value: unknown): value is AuthoredScenario {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string") return false;
  const spec = value.spec;
  if (!isRecord(spec)) return false;
  if (!Object.keys(LIMITS).every((field) => typeof spec[field] === "number")) return false;
  return asArray(value.script).every(
    (event) =>
      isRecord(event) &&
      typeof event.tick === "number" &&
      typeof event.dxPermille === "number" &&
      typeof event.dyPermille === "number" &&
      (event.action === "move" || event.action === "fire" || event.action === "stop"),
  );
}

function isProfileShaped(value: unknown): value is NetworkProfile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string") return false;
  if (typeof value.description !== "string") return false;
  return asArray(value.segments).every(
    (segment) =>
      isRecord(segment) &&
      typeof segment.weightPermille === "number" &&
      typeof segment.rttMeanMs === "number" &&
      typeof segment.rttJitterMs === "number" &&
      typeof segment.lossPct === "number" &&
      typeof segment.reorderPct === "number" &&
      typeof segment.duplicatePct === "number" &&
      typeof segment.burstLoss === "boolean",
  );
}

/** A copy under a fresh id, so a built-in can be edited without being replaced. */
export function duplicateScenario(
  scenario: AuthoredScenario,
  existing: readonly AuthoredScenario[],
): AuthoredScenario {
  return {
    ...scenario,
    id: freshId(scenario.id, [...existing.map((s) => s.id), ...BUILT_IN_SCENARIOS.map((s) => s.id)]),
    name: `${scenario.name} copy`,
    spec: { ...scenario.spec },
    script: scenario.script.map((event) => ({ ...event })),
  };
}

export function duplicateProfile(
  profile: NetworkProfile,
  existing: readonly NetworkProfile[],
): NetworkProfile {
  return {
    ...profile,
    id: freshId(profile.id, [...existing.map((p) => p.id), ...PROFILES.map((p) => p.id)]),
    name: `${profile.name} copy`,
    segments: profile.segments.map((segment) => ({ ...segment })),
  };
}

function freshId(base: string, taken: readonly string[]): string {
  const stem = base.replace(/-\d+$/, "");
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export interface ExportFile {
  schemaVersion: number;
  scenarios: AuthoredScenario[];
  profiles: NetworkProfile[];
}

export function toExport(value: Authored): ExportFile {
  return { schemaVersion: SCHEMA_VERSION, ...value };
}

export interface ImportOutcome {
  value: Authored;
  problems: string[];
}

/**
 * Reads an exported file back, rejecting rather than repairing.
 *
 * Every rejection names what was wrong. An import that silently dropped a malformed
 * scenario would leave the user looking at a list that is missing something they
 * believe they just imported.
 */
export function fromImport(raw: string): ImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: EMPTY, problems: ["That file is not valid JSON."] };
  }

  if (!isRecord(parsed)) {
    return { value: EMPTY, problems: ["That file does not describe scenarios or profiles."] };
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return {
      value: EMPTY,
      problems: [
        `That file is schema version ${String(parsed.schemaVersion ?? "unset")}, and this build reads version ${SCHEMA_VERSION}.`,
      ],
    };
  }

  const problems: string[] = [];
  const scenarios: AuthoredScenario[] = [];
  asArray(parsed.scenarios).forEach((candidate, i) => {
    if (!isScenarioShaped(candidate)) {
      problems.push(`Scenario ${i + 1} is missing fields this build needs.`);
      return;
    }
    const found = validateScenario(candidate);
    if (found.length > 0) {
      problems.push(`${candidate.name || `Scenario ${i + 1}`}: ${found.join(" ")}`);
      return;
    }
    scenarios.push(candidate);
  });

  const profiles: NetworkProfile[] = [];
  asArray(parsed.profiles).forEach((candidate, i) => {
    if (!isProfileShaped(candidate)) {
      problems.push(`Profile ${i + 1} is missing fields this build needs.`);
      return;
    }
    const found = validateProfile(candidate);
    if (found.length > 0) {
      problems.push(`${candidate.name || `Profile ${i + 1}`}: ${found.join(" ")}`);
      return;
    }
    profiles.push(candidate);
  });

  return { value: { scenarios, profiles }, problems };
}
