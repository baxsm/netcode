import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  Lock,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import StatusNote from "../components/status-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
    <div className="space-y-6">
      <header className="max-w-3xl space-y-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Scenarios</h1>
        <p className="text-sm text-muted-foreground">
          What gets simulated, and against which players. A scenario is one controllable
          body and the inputs it receives, because that is what the core integrates.
          Built-ins are read-only, so duplicate one to change it.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
        <Label htmlFor="scenario-pick" className="text-xs text-muted-foreground">
          Scenario
        </Label>
        <Select
          value={scenario?.id ?? ""}
          onValueChange={(v) => {
            if (typeof v === "string") setScenarioId(v);
          }}
        >
          <SelectTrigger id="scenario-pick" className="w-60">
            <SelectValue>{() => scenario?.name ?? ""}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Built in</SelectLabel>
              {BUILT_IN_SCENARIOS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectGroup>
            {authored.scenarios.length > 0 ? (
              <SelectGroup>
                <SelectLabel>Yours</SelectLabel>
                {authored.scenarios.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>

        {scenarioReadOnly ? (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            <Lock className="size-3" aria-hidden />
            Read only
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {/* a built-in cannot be edited, so duplicating one is how any authoring
              starts. it is the primary here, and the only primary on this row */}
          <Button onClick={duplicate} size="sm" data-testid="duplicate">
            <Copy data-icon="inline-start" />
            Duplicate
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="open-in-replay"
            disabled={scenarioProblems.length > 0}
            onClick={() => scenario && navigate("/", { scenario: scenario.id })}
          >
            <ExternalLink data-icon="inline-start" />
            Open in replay
          </Button>
          {scenarioReadOnly ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="destructive"
                    size="icon-sm"
                    onClick={removeScenario}
                    data-testid="delete"
                    aria-label="Delete this scenario"
                  >
                    <Trash2 />
                  </Button>
                }
              />
              <TooltipContent>Delete this scenario</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

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

      <Separator />

      <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
        <Label htmlFor="profile-pick" className="text-xs text-muted-foreground">
          Profile
        </Label>
        <Select
          value={profile?.id ?? ""}
          onValueChange={(v) => {
            if (typeof v === "string") setProfileId(v);
          }}
        >
          <SelectTrigger id="profile-pick" className="w-60">
            <SelectValue>{() => profile?.name ?? ""}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Built in</SelectLabel>
              {PROFILES.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectGroup>
            {authored.profiles.length > 0 ? (
              <SelectGroup>
                <SelectLabel>Yours</SelectLabel>
                {authored.profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>

        {profileReadOnly ? (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            <Lock className="size-3" aria-hidden />
            Read only
          </Badge>
        ) : null}

        {/* secondary next to the scenario row's primary: duplicating a profile is a
            supporting action on this page, not a second headline one */}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={duplicateCurrentProfile}
            data-testid="duplicate-profile"
          >
            <Copy data-icon="inline-start" />
            Duplicate
          </Button>
          {profileReadOnly ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="destructive"
                    size="icon-sm"
                    onClick={removeProfile}
                    data-testid="delete-profile"
                    aria-label="Delete this profile"
                  >
                    <Trash2 />
                  </Button>
                }
              />
              <TooltipContent>Delete this profile</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {profile ? (
        <ProfileEditor
          profile={profile}
          readOnly={profileReadOnly}
          problems={profileProblems}
          onChange={updateProfile}
        />
      ) : null}

      <Card aria-labelledby="transfer-heading">
        <CardHeader>
          <CardTitle id="transfer-heading">Import and export</CardTitle>
          <CardDescription>
            Authored scenarios live in this browser. Export them to keep them anywhere
            else.
          </CardDescription>
          <CardAction>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                data-testid="export"
                onClick={() =>
                  downloadJson(
                    "netcode-scenarios.json",
                    JSON.stringify(toExport(authored), null, 2),
                  )
                }
              >
                <Download data-icon="inline-start" />
                Export yours
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="import"
                onClick={() => fileInput.current?.click()}
              >
                <Upload data-icon="inline-start" />
                Import
              </Button>
            </div>
          </CardAction>
        </CardHeader>

        <CardContent className="space-y-3">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Import scenarios and profiles"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
              // cleared so importing the same file twice still fires a change
              e.target.value = "";
            }}
          />

          {authored.scenarios.length + authored.profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="nothing-authored">
              Nothing authored yet. Duplicate a built-in to start, then export it to
              keep it outside this browser.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="authored-count">
              <span className="tabular text-foreground">
                {authored.scenarios.length}
              </span>{" "}
              scenarios and{" "}
              <span className="tabular text-foreground">
                {authored.profiles.length}
              </span>{" "}
              profiles saved in this browser.
            </p>
          )}

          {imported ? (
            <StatusNote data-testid="import-result">{imported}</StatusNote>
          ) : null}

          {importProblems.length > 0 ? (
            <ul
              className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
              data-testid="import-problems"
              role="alert"
            >
              {importProblems.map((problem) => (
                <li
                  key={problem}
                  className="flex items-start gap-2 text-sm text-destructive"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {problem}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Exports carry a schema version. A file written by a different version is
            rejected with its reason rather than loaded with fields this build would
            guess at.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default ScenariosPage;
