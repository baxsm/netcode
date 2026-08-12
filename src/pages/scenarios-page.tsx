import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import InputScriptEditor from "../components/input-script-editor";
import ProfileEditor from "../components/profile-editor";
import ScenarioEditor from "../components/scenario-editor";
import { useNavigate } from "../router";
import { downloadJson } from "../sweep/report";
import { PROFILES, type NetworkProfile } from "../sweep/profiles";
import {
  BUILT_IN_SCENARIOS,
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
  type Authored,
  type AuthoredScenario,
} from "../scenarios/store";

/**
 * Authoring, held in `localStorage`.
 *
 * Built-ins are read-only and duplicable rather than editable in place. Editing one
 * would leave the app running a scenario the tests still name, under an id that no
 * longer describes it.
 */
const ScenariosPage: FC = () => {
  const navigate = useNavigate();
  const [authored, setAuthored] = useState<Authored>(() => load());
  // restored from storage, so reloading mid-edit lands back on what was being edited
  // rather than on the first built-in
  const [scenarioId, setScenarioId] = useState(
    () => authored.editing?.scenarioId ?? BUILT_IN_SCENARIOS[0]?.id ?? "drift",
  );
  const [profileId, setProfileId] = useState(
    () => authored.editing?.profileId ?? PROFILES[0]?.id ?? "mixed",
  );
  const [importProblems, setImportProblems] = useState<string[]>([]);
  const [imported, setImported] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    save({ ...authored, editing: { scenarioId, profileId } });
  }, [authored, scenarioId, profileId]);

  const scenarios = useMemo(
    () => [...BUILT_IN_SCENARIOS, ...authored.scenarios],
    [authored.scenarios],
  );
  const profiles = useMemo(() => [...PROFILES, ...authored.profiles], [authored.profiles]);

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? scenarios[0];
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];

  const scenarioReadOnly = !scenario || isBuiltInScenario(scenario.id);
  const profileReadOnly = !profile || isBuiltInProfile(profile.id);

  const scenarioProblems = useMemo(
    () => (scenario ? validateScenario(scenario) : []),
    [scenario],
  );
  const profileProblems = useMemo(() => (profile ? validateProfile(profile) : []), [profile]);

  const updateScenario = useCallback((next: AuthoredScenario) => {
    setAuthored((current) => ({
      ...current,
      scenarios: current.scenarios.map((s) => (s.id === next.id ? next : s)),
    }));
  }, []);

  const updateProfile = useCallback((next: NetworkProfile) => {
    setAuthored((current) => ({
      ...current,
      profiles: current.profiles.map((p) => (p.id === next.id ? next : p)),
    }));
  }, []);

  const duplicate = useCallback(() => {
    if (!scenario) return;
    const copy = duplicateScenario(scenario, authored.scenarios);
    setAuthored((current) => ({ ...current, scenarios: [...current.scenarios, copy] }));
    setScenarioId(copy.id);
  }, [authored.scenarios, scenario]);

  const duplicateCurrentProfile = useCallback(() => {
    if (!profile) return;
    const copy = duplicateProfile(profile, authored.profiles);
    setAuthored((current) => ({ ...current, profiles: [...current.profiles, copy] }));
    setProfileId(copy.id);
  }, [authored.profiles, profile]);

  const removeScenario = useCallback(() => {
    if (!scenario || isBuiltInScenario(scenario.id)) return;
    setAuthored((current) => ({
      ...current,
      scenarios: current.scenarios.filter((s) => s.id !== scenario.id),
    }));
    setScenarioId(BUILT_IN_SCENARIOS[0]?.id ?? "drift");
  }, [scenario]);

  const removeProfile = useCallback(() => {
    if (!profile || isBuiltInProfile(profile.id)) return;
    setAuthored((current) => ({
      ...current,
      profiles: current.profiles.filter((p) => p.id !== profile.id),
    }));
    setProfileId(PROFILES[0]?.id ?? "mixed");
  }, [profile]);

  /**
   * Import merges by id, replacing anything already authored under the same one.
   *
   * Rejections are reported rather than dropped. An import that quietly discarded a
   * malformed scenario would leave the user reading a list missing something they
   * believe they just imported.
   */
  const readFile = useCallback(async (file: File) => {
    const outcome = fromImport(await file.text());
    setImportProblems(outcome.problems);

    const added = outcome.value.scenarios.length + outcome.value.profiles.length;
    setImported(
      added === 0
        ? ""
        : `Imported ${outcome.value.scenarios.length} scenarios and ${outcome.value.profiles.length} profiles.`,
    );

    if (added === 0) return;
    setAuthored((current) => ({
      scenarios: [
        ...current.scenarios.filter(
          (s) => !outcome.value.scenarios.some((next) => next.id === s.id),
        ),
        ...outcome.value.scenarios,
      ],
      profiles: [
        ...current.profiles.filter((p) => !outcome.value.profiles.some((next) => next.id === p.id)),
        ...outcome.value.profiles,
      ],
    }));
  }, []);

  return (
    <>
      <header>
        <h1>Scenarios</h1>
        <p>
          What gets simulated, and against which players. A scenario is one controllable
          body and the inputs it receives, because that is what the core integrates.
          Built-ins are read-only, so duplicate one to change it.
        </p>
      </header>

      <section className="controls">
        <div className="field inline">
          <label htmlFor="scenario-pick">Scenario</label>
          <select
            id="scenario-pick"
            value={scenario?.id ?? ""}
            onChange={(e) => setScenarioId(e.target.value)}
          >
            <optgroup label="Built in">
              {BUILT_IN_SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            {authored.scenarios.length > 0 ? (
              <optgroup label="Yours">
                {authored.scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>

        <button type="button" className="ghost" onClick={duplicate} data-testid="duplicate">
          Duplicate
        </button>
        {scenarioReadOnly ? null : (
          <button type="button" className="ghost" onClick={removeScenario} data-testid="delete">
            Delete
          </button>
        )}
        <button
          type="button"
          className="ghost"
          data-testid="open-in-replay"
          disabled={scenarioProblems.length > 0}
          onClick={() => scenario && navigate("/", { scenario: scenario.id })}
        >
          Open in replay
        </button>
      </section>

      {scenario ? (
        <>
          <ScenarioEditor
            scenario={scenario}
            readOnly={scenarioReadOnly}
            problems={scenarioProblems}
            onChange={updateScenario}
          />
          <InputScriptEditor
            script={scenario.script}
            tickRate={scenario.spec.tickRate}
            durationTicks={scenario.spec.durationTicks}
            readOnly={scenarioReadOnly}
            onChange={(script) => updateScenario({ ...scenario, script })}
          />
        </>
      ) : null}

      <section className="controls">
        <div className="field inline">
          <label htmlFor="profile-pick">Profile</label>
          <select
            id="profile-pick"
            value={profile?.id ?? ""}
            onChange={(e) => setProfileId(e.target.value)}
          >
            <optgroup label="Built in">
              {PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {authored.profiles.length > 0 ? (
              <optgroup label="Yours">
                {authored.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>

        <button
          type="button"
          className="ghost"
          onClick={duplicateCurrentProfile}
          data-testid="duplicate-profile"
        >
          Duplicate
        </button>
        {profileReadOnly ? null : (
          <button
            type="button"
            className="ghost"
            onClick={removeProfile}
            data-testid="delete-profile"
          >
            Delete
          </button>
        )}
      </section>

      {profile ? (
        <ProfileEditor
          profile={profile}
          readOnly={profileReadOnly}
          problems={profileProblems}
          onChange={updateProfile}
        />
      ) : null}

      <section className="panel" aria-labelledby="transfer-heading">
        <div className="panel-head">
          <h2 id="transfer-heading">Import and export</h2>
          <div className="panel-actions">
            <button
              type="button"
              className="ghost"
              data-testid="export"
              onClick={() =>
                downloadJson("netcode-scenarios.json", JSON.stringify(toExport(authored), null, 2))
              }
            >
              Export yours
            </button>
            <button
              type="button"
              className="ghost"
              data-testid="import"
              onClick={() => fileInput.current?.click()}
            >
              Import
            </button>
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          aria-label="Import scenarios and profiles"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
            // cleared so importing the same file twice still fires a change
            e.target.value = "";
          }}
        />

        {authored.scenarios.length + authored.profiles.length === 0 ? (
          <p className="state" data-testid="nothing-authored">
            Nothing authored yet. Duplicate a built-in to start, then export it to keep it
            outside this browser.
          </p>
        ) : (
          <p className="state" data-testid="authored-count">
            {authored.scenarios.length} scenarios and {authored.profiles.length} profiles
            saved in this browser.
          </p>
        )}

        {imported ? (
          <p className="state" data-testid="import-result" role="status">
            {imported}
          </p>
        ) : null}

        {importProblems.length > 0 ? (
          <ul className="problems" data-testid="import-problems" role="alert">
            {importProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}

        <p className="note">
          Exports carry a schema version. A file written by a different version is
          rejected with its reason rather than loaded with fields this build would guess
          at.
        </p>
      </section>
    </>
  );
};

export default ScenariosPage;
