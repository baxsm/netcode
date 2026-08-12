/**
 * The scenario list, resolved for the routes that run one.
 *
 * Authoring that nothing consumes would be an editor for its own sake, so the replay
 * and the sweep both read from here rather than from a constant. Built-ins come first
 * and are always present, which is what keeps a route working when storage is empty
 * or has been cleared.
 */

import { useEffect, useMemo, useState } from "react";
import { BUILT_IN_SCENARIOS, load, type AuthoredScenario } from "./store";
import { PROFILES, type NetworkProfile } from "../sweep/profiles";

export interface ScenarioChoices {
  scenarios: AuthoredScenario[];
  profiles: NetworkProfile[];
  /** The named scenario, or the first built-in when the name is unknown. */
  scenarioFor: (id: string | null) => AuthoredScenario;
  profileFor: (id: string | null) => NetworkProfile;
}

export function useScenarios(): ScenarioChoices {
  const [authored, setAuthored] = useState(() => load());

  /**
   * Re-read when another tab writes, so two open windows do not disagree about which
   * scenarios exist. `storage` only fires in the tabs that did not make the change,
   * which is exactly the case this covers.
   */
  useEffect(() => {
    const reload = () => setAuthored(load());
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, []);

  return useMemo(() => {
    const scenarios = [...BUILT_IN_SCENARIOS, ...authored.scenarios];
    const profiles = [...PROFILES, ...authored.profiles];
    return {
      scenarios,
      profiles,
      // the first built-in rather than nothing, because a route that cannot resolve a
      // scenario has no run to show and an empty page would read as a failure
      scenarioFor: (id) =>
        (id ? scenarios.find((s) => s.id === id) : undefined) ??
        (BUILT_IN_SCENARIOS[0] as AuthoredScenario),
      profileFor: (id) =>
        (id ? profiles.find((p) => p.id === id) : undefined) ?? (PROFILES[0] as NetworkProfile),
    };
  }, [authored]);
}
