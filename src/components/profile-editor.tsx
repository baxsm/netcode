import type { FC } from "react";
import type { WeightedSegment } from "../sim/types";
import { FULL_WEIGHT, totalWeight, weightsAreWhole, type NetworkProfile } from "../sweep/profiles";

interface ProfileEditorProps {
  profile: NetworkProfile;
  readOnly: boolean;
  problems: string[];
  onChange: (profile: NetworkProfile) => void;
}

/** The numeric conditions on a segment, each with the unit it is argued in. */
const CONDITIONS: Array<{
  field: keyof Omit<WeightedSegment, "burstLoss">;
  label: string;
  max: number;
}> = [
  { field: "weightPermille", label: "Share", max: 1000 },
  { field: "rttMeanMs", label: "RTT ms", max: 60_000 },
  { field: "rttJitterMs", label: "Jitter ms", max: 60_000 },
  { field: "lossPct", label: "Loss %", max: 100 },
  { field: "reorderPct", label: "Reorder %", max: 100 },
  { field: "duplicatePct", label: "Duplicate %", max: 100 },
];

/**
 * Distinguishable at a glance and reused per index, so a segment keeps its colour
 * between the bar and the rows below it.
 */
const SEGMENT_COLOURS = ["#58a6ff", "#f0883e", "#3fb950", "#a371f7", "#e6edf3", "#8b949e"];

function colourFor(index: number): string {
  return SEGMENT_COLOURS[index % SEGMENT_COLOURS.length] as string;
}

const EMPTY_SEGMENT: WeightedSegment = {
  weightPermille: 100,
  rttMeanMs: 60,
  rttJitterMs: 15,
  lossPct: 1,
  reorderPct: 0,
  duplicatePct: 0,
  burstLoss: false,
};

const ProfileEditor: FC<ProfileEditorProps> = ({ profile, readOnly, problems, onChange }) => {
  const total = totalWeight(profile.segments);
  const whole = weightsAreWhole(profile.segments);

  const setSegment = (index: number, patch: Partial<WeightedSegment>) => {
    onChange({
      ...profile,
      segments: profile.segments.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  };

  return (
    <section className="panel" aria-labelledby="profile-editor-heading">
      <div className="panel-head">
        <h2 id="profile-editor-heading">Network profile</h2>
        {readOnly ? (
          <span className="muted" data-testid="profile-read-only">
            Built in, duplicate it to edit
          </span>
        ) : (
          <div className="panel-actions">
            <button
              type="button"
              className="ghost"
              data-testid="add-segment"
              onClick={() => onChange({ ...profile, segments: [...profile.segments, EMPTY_SEGMENT] })}
            >
              Add segment
            </button>
          </div>
        )}
      </div>

      <div className="sweep-fields">
        <div className="field">
          <label htmlFor="profile-name">Name</label>
          <input
            id="profile-name"
            type="text"
            value={profile.name}
            disabled={readOnly}
            onChange={(e) => onChange({ ...profile, name: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="profile-description">Description</label>
          <input
            id="profile-description"
            type="text"
            value={profile.description}
            disabled={readOnly}
            onChange={(e) => onChange({ ...profile, description: e.target.value })}
          />
          <span className="field-note">Who these players are, in one line.</span>
        </div>
      </div>

      {/* the population as one bar, because a distribution is the input that decides
          which configuration wins and a column of numbers does not show its shape */}
      {profile.segments.length > 0 ? (
        <div
          className="stacked-bar"
          data-testid="segment-bar"
          role="img"
          aria-label={`Population split across ${profile.segments.length} segments, totalling ${(total / 10).toFixed(0)} percent`}
        >
          {profile.segments.map((segment, index) => (
            <span
              key={index}
              style={{
                width: `${(segment.weightPermille / Math.max(total, 1)) * 100}%`,
                background: colourFor(index),
              }}
            />
          ))}
        </div>
      ) : null}

      {profile.segments.length === 0 ? (
        <p className="state" data-testid="profile-empty">
          No segments. Add one to describe a group of players.
        </p>
      ) : (
        <div className="table-wrap profile-table">
          <table>
            <thead>
              <tr>
                <th scope="col">{""}</th>
                {CONDITIONS.map((condition) => (
                  <th scope="col" key={condition.field}>
                    {condition.label}
                  </th>
                ))}
                <th scope="col">Burst</th>
                {readOnly ? null : <th scope="col">{""}</th>}
              </tr>
            </thead>
            <tbody>
              {profile.segments.map((segment, index) => (
                <tr key={index} data-testid="segment-row">
                  <th scope="row">
                    <span className="swatch" style={{ background: colourFor(index) }} />
                    Segment {index + 1}
                  </th>
                  {CONDITIONS.map(({ field, label, max }) => (
                    <td key={field}>
                      <input
                        type="number"
                        aria-label={`Segment ${index + 1} ${label}`}
                        value={segment[field]}
                        min={0}
                        max={max}
                        disabled={readOnly}
                        onChange={(e) =>
                          setSegment(index, { [field]: Math.trunc(Number(e.target.value)) })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Segment ${index + 1} burst loss`}
                      checked={segment.burstLoss}
                      disabled={readOnly}
                      onChange={(e) => setSegment(index, { burstLoss: e.target.checked })}
                    />
                  </td>
                  {readOnly ? null : (
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        aria-label={`Remove segment ${index + 1}`}
                        onClick={() =>
                          onChange({
                            ...profile,
                            segments: profile.segments.filter((_, i) => i !== index),
                          })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* the core renormalizes whatever it is given, so a profile that does not sum to
          a whole population still runs. it would just answer a different question than
          the one on screen, which is why this says so rather than silently correcting */}
      {whole || profile.segments.length === 0 ? null : (
        <p className="state error" data-testid="weight-warning" role="alert">
          Segment shares total {(total / 10).toFixed(1)}% rather than 100%. The run will
          scale them to a whole population, so the shares are treated as relative rather
          than as the numbers entered.
        </p>
      )}

      {problems.length > 0 ? (
        <ul className="problems" data-testid="profile-problems" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <p className="note">
        Shares are permille, so a whole population sums to {FULL_WEIGHT}. Burst loss
        replaces independent drops with a two-state model, where losses arrive in runs
        rather than spread evenly.
      </p>
    </section>
  );
};

export default ProfileEditor;
