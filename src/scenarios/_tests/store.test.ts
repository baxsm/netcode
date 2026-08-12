import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SCENARIOS,
  EMPTY,
  SCHEMA_VERSION,
  duplicateProfile,
  duplicateScenario,
  fromImport,
  isBuiltInProfile,
  isBuiltInScenario,
  load,
  save,
  toExport,
  validateProfile,
  validateScenario,
  type AuthoredScenario,
} from "../store";
import { PROFILES, type NetworkProfile } from "../../sweep/profiles";
import { DEFAULT_SCENARIO } from "../../sim/types";

/** A storage that behaves like the browser's, so the store is tested against one. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function scenario(overrides: Partial<AuthoredScenario> = {}): AuthoredScenario {
  return {
    id: "mine",
    name: "Mine",
    spec: { ...DEFAULT_SCENARIO },
    script: [{ tick: 0, action: "move", dxPermille: 1000, dyPermille: 0 }],
    ...overrides,
  };
}

function profile(overrides: Partial<NetworkProfile> = {}): NetworkProfile {
  return {
    id: "mine",
    name: "Mine",
    description: "A population",
    segments: [
      {
        weightPermille: 1000,
        rttMeanMs: 60,
        rttJitterMs: 15,
        lossPct: 1,
        reorderPct: 0,
        duplicatePct: 0,
        burstLoss: false,
      },
    ],
    ...overrides,
  };
}

describe("built-ins", () => {
  it("are recognised by id", () => {
    expect(isBuiltInScenario("drift")).toBe(true);
    expect(isBuiltInScenario("mine")).toBe(false);
    expect(isBuiltInProfile(PROFILES[0]?.id ?? "")).toBe(true);
    expect(isBuiltInProfile("mine")).toBe(false);
  });

  it("all validate", () => {
    for (const built of BUILT_IN_SCENARIOS) {
      expect(validateScenario(built), built.id).toEqual([]);
    }
    for (const built of PROFILES) {
      expect(validateProfile(built), built.id).toEqual([]);
    }
  });

  /**
   * The rewind limit was inert through Phase 4 because no scenario fired. At least
   * one built-in has to fire, or the constant goes back to being unmeasurable.
   */
  it("include a scenario that fires", () => {
    const firing = BUILT_IN_SCENARIOS.filter((s) =>
      s.script.some((event) => event.action === "fire"),
    );
    expect(firing.length).toBeGreaterThan(0);
  });

  it("have unique ids", () => {
    const ids = BUILT_IN_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scenario validation", () => {
  it("accepts a well formed scenario", () => {
    expect(validateScenario(scenario())).toEqual([]);
  });

  it("names the field that is out of range", () => {
    const problems = validateScenario(
      scenario({ spec: { ...DEFAULT_SCENARIO, tickRate: 0 } }),
    );
    expect(problems.join(" ")).toContain("tickRate");
  });

  it("rejects a fractional constant", () => {
    const problems = validateScenario(
      scenario({ spec: { ...DEFAULT_SCENARIO, accel: 10.5 } }),
    );
    expect(problems.join(" ")).toContain("accel");
  });

  it("rejects an empty name", () => {
    expect(validateScenario(scenario({ name: " " })).join(" ")).toContain("name");
  });

  /**
   * An input past the end of the run would never fire, so the editor says so rather
   * than letting the user believe a scripted shot happened.
   */
  it("rejects an input past the end of the run", () => {
    const problems = validateScenario(
      scenario({
        spec: { ...DEFAULT_SCENARIO, durationTicks: 100 },
        script: [{ tick: 400, action: "fire", dxPermille: 1000, dyPermille: 0 }],
      }),
    );
    expect(problems.join(" ")).toContain("never fire");
  });

  it("rejects a direction outside permille", () => {
    const problems = validateScenario(
      scenario({ script: [{ tick: 0, action: "move", dxPermille: 5000, dyPermille: 0 }] }),
    );
    expect(problems.join(" ")).toContain("dxPermille");
  });

  it("rejects a negative tick", () => {
    const problems = validateScenario(
      scenario({ script: [{ tick: -1, action: "move", dxPermille: 1000, dyPermille: 0 }] }),
    );
    expect(problems.join(" ")).toContain("tick");
  });
});

describe("profile validation", () => {
  it("accepts a well formed profile", () => {
    expect(validateProfile(profile())).toEqual([]);
  });

  it("rejects a profile with no segments", () => {
    expect(validateProfile(profile({ segments: [] })).join(" ")).toContain("at least one");
  });

  it("rejects a zero weight", () => {
    const p = profile();
    const first = p.segments[0];
    if (!first) throw new Error("fixture has no segment");
    const problems = validateProfile({
      ...p,
      segments: [{ ...first, weightPermille: 0 }],
    });
    expect(problems.join(" ")).toContain("weight");
  });

  it("rejects loss above 100 percent", () => {
    const p = profile();
    const first = p.segments[0];
    if (!first) throw new Error("fixture has no segment");
    const problems = validateProfile({ ...p, segments: [{ ...first, lossPct: 120 }] });
    expect(problems.join(" ")).toContain("lossPct");
  });

  /**
   * Weights that do not sum to a whole population are a warning rather than an
   * error, because the core renormalizes and the run is still meaningful. The
   * interface says what it did instead of silently correcting it.
   */
  it("accepts weights that do not sum to a whole population", () => {
    const p = profile();
    const first = p.segments[0];
    if (!first) throw new Error("fixture has no segment");
    expect(validateProfile({ ...p, segments: [{ ...first, weightPermille: 400 }] })).toEqual(
      [],
    );
  });
});

describe("persistence", () => {
  it("round trips through storage", () => {
    const storage = memoryStorage();
    const value = { scenarios: [scenario()], profiles: [profile()] };
    save(value, storage);
    expect(load(storage)).toMatchObject(value);
  });

  /**
   * Reloading mid-edit and landing back on the first built-in loses your place in the
   * one surface where a reload is most likely, so the selection is stored with the
   * scenarios rather than left to a default.
   */
  it("remembers what was being edited", () => {
    const storage = memoryStorage();
    save(
      { scenarios: [scenario()], profiles: [], editing: { scenarioId: "mine", profileId: "p" } },
      storage,
    );
    expect(load(storage).editing).toEqual({ scenarioId: "mine", profileId: "p" });
  });

  it("ignores a stored selection that is not a string", () => {
    const storage = memoryStorage({
      "netcode.authored.v1": JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        scenarios: [],
        profiles: [],
        editing: { scenarioId: 7 },
      }),
    });
    expect(load(storage).editing).toEqual({});
  });

  it("returns nothing when storage is empty", () => {
    expect(load(memoryStorage())).toEqual(EMPTY);
  });

  it("returns nothing when storage is unavailable", () => {
    expect(load(null)).toEqual(EMPTY);
  });

  it("ignores a stored value from a different schema version", () => {
    const storage = memoryStorage({
      "netcode.authored.v1": JSON.stringify({
        schemaVersion: SCHEMA_VERSION + 1,
        scenarios: [scenario()],
        profiles: [],
      }),
    });
    expect(load(storage)).toEqual(EMPTY);
  });

  it("ignores unparseable storage rather than throwing", () => {
    const storage = memoryStorage({ "netcode.authored.v1": "{not json" });
    expect(load(storage)).toEqual(EMPTY);
  });

  /**
   * A stored scenario that no longer validates is dropped rather than repaired.
   * Repairing it would run something the user never authored.
   */
  it("drops a stored scenario that no longer validates", () => {
    const storage = memoryStorage({
      "netcode.authored.v1": JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        scenarios: [scenario(), scenario({ id: "bad", spec: { ...DEFAULT_SCENARIO, tickRate: 0 } })],
        profiles: [],
      }),
    });
    expect(load(storage).scenarios.map((s) => s.id)).toEqual(["mine"]);
  });

  /** A string where a number belongs would pass a range check, so shape runs first. */
  it("drops a stored scenario with a field of the wrong type", () => {
    const storage = memoryStorage({
      "netcode.authored.v1": JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        scenarios: [{ ...scenario(), spec: { ...DEFAULT_SCENARIO, tickRate: "64" } }],
        profiles: [],
      }),
    });
    expect(load(storage).scenarios).toEqual([]);
  });
});

describe("duplication", () => {
  it("gives the copy a fresh id", () => {
    const copy = duplicateScenario(scenario(), [scenario()]);
    expect(copy.id).not.toBe("mine");
    expect(copy.name).toBe("Mine copy");
  });

  it("does not collide with a built-in id", () => {
    const built = BUILT_IN_SCENARIOS[0];
    if (!built) throw new Error("no built-in scenario");
    const copy = duplicateScenario(built, []);
    expect(isBuiltInScenario(copy.id)).toBe(false);
  });

  it("keeps duplicating past an existing copy", () => {
    const first = duplicateScenario(scenario(), []);
    const second = duplicateScenario(scenario(), [first]);
    expect(second.id).not.toBe(first.id);
  });

  /** A shallow copy would let editing the duplicate rewrite the original's script. */
  it("copies the script rather than sharing it", () => {
    const original = scenario();
    const copy = duplicateScenario(original, []);
    const firstEvent = copy.script[0];
    if (!firstEvent) throw new Error("copy has no script");
    firstEvent.tick = 99;
    expect(original.script[0]?.tick).toBe(0);
  });

  it("copies a profile's segments rather than sharing them", () => {
    const original = profile();
    const copy = duplicateProfile(original, []);
    const firstSegment = copy.segments[0];
    if (!firstSegment) throw new Error("copy has no segment");
    firstSegment.rttMeanMs = 999;
    expect(original.segments[0]?.rttMeanMs).toBe(60);
  });
});

describe("import and export", () => {
  it("round trips without loss", () => {
    const value = { scenarios: [scenario()], profiles: [profile()] };
    const outcome = fromImport(JSON.stringify(toExport(value)));
    expect(outcome.problems).toEqual([]);
    expect(outcome.value).toEqual(value);
  });

  it("stamps the schema version on export", () => {
    expect(toExport(EMPTY).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("rejects a file from a different schema version", () => {
    const outcome = fromImport(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, scenarios: [], profiles: [] }),
    );
    expect(outcome.problems.join(" ")).toContain("schema version");
    expect(outcome.value).toEqual(EMPTY);
  });

  it("rejects a file that is not JSON", () => {
    expect(fromImport("nonsense").problems.join(" ")).toContain("not valid JSON");
  });

  it("rejects a file that is not an object", () => {
    expect(fromImport("[]").problems.length).toBeGreaterThan(0);
  });

  /**
   * The named silent failure for import is a scenario bypassing validation and
   * failing inside the core instead. Every rejection has to name what was wrong.
   */
  it("names the scenario it rejected rather than dropping it quietly", () => {
    const broken = scenario({ id: "broken", name: "Broken", spec: { ...DEFAULT_SCENARIO, tickRate: 0 } });
    const outcome = fromImport(
      JSON.stringify(toExport({ scenarios: [scenario(), broken], profiles: [] })),
    );
    expect(outcome.value.scenarios.map((s) => s.id)).toEqual(["mine"]);
    expect(outcome.problems.join(" ")).toContain("Broken");
    expect(outcome.problems.join(" ")).toContain("tickRate");
  });

  it("names a profile it rejected", () => {
    const outcome = fromImport(
      JSON.stringify(
        toExport({ scenarios: [], profiles: [profile({ name: "Bad", segments: [] })] }),
      ),
    );
    expect(outcome.problems.join(" ")).toContain("Bad");
  });

  it("reports a scenario that is missing fields", () => {
    const outcome = fromImport(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, scenarios: [{ id: "x" }], profiles: [] }),
    );
    expect(outcome.problems.join(" ")).toContain("missing fields");
  });
});
