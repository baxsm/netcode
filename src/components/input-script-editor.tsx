import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import {
  ACTION_LABELS,
  INPUT_ACTIONS,
  type InputActionKind,
  type InputEventSpec,
} from "../sim/types";
import {
  CONTROL_HINTS,
  FIRE_KEY,
  KEY_BINDINGS,
  emptyRecorder,
  finish,
  fireAt,
  keyDown,
  keyUp,
  sampleTick,
  tickAt,
  type RecorderState,
} from "../scenarios/record";

interface InputScriptEditorProps {
  script: InputEventSpec[];
  tickRate: number;
  durationTicks: number;
  readOnly: boolean;
  onChange: (script: InputEventSpec[]) => void;
}

/** A new row lands one tick past the last, so it never collides with an existing one. */
function nextTick(script: readonly InputEventSpec[], durationTicks: number): number {
  const last = script.reduce((highest, event) => Math.max(highest, event.tick), -1);
  return Math.min(last + 1, Math.max(0, durationTicks - 1));
}

const InputScriptEditor: FC<InputScriptEditorProps> = ({
  script,
  tickRate,
  durationTicks,
  readOnly,
  onChange,
}) => {
  const [recording, setRecording] = useState(false);
  const [recordTick, setRecordTick] = useState(0);

  /**
   * The recorder is read and written inside listeners and an animation frame, so it
   * lives in a ref. Held in state it would be captured stale by the keydown handler
   * registered when recording started, and every key would be applied to the state
   * as it was at that moment.
   */
  const recorder = useRef<RecorderState>(emptyRecorder());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const stop = useCallback(() => {
    setRecording(false);
    onChangeRef.current(finish(recorder.current));
  }, []);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    if (!recording) return;

    recorder.current = emptyRecorder();
    const startedAt = performance.now();

    const down = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        stopRef.current();
        return;
      }
      if (event.key !== FIRE_KEY && !KEY_BINDINGS[event.key]) return;
      // arrows scroll the page and space activates whatever has focus, both of which
      // would fight the recording rather than feed it
      event.preventDefault();
      if (event.repeat) return;

      const tick = tickAt(performance.now() - startedAt, tickRate);
      recorder.current =
        event.key === FIRE_KEY
          ? fireAt(recorder.current, tick)
          : sampleTick(keyDown(recorder.current, event.key), tick);
    };

    const up = (event: KeyboardEvent) => {
      if (!KEY_BINDINGS[event.key]) return;
      event.preventDefault();
      const tick = tickAt(performance.now() - startedAt, tickRate);
      recorder.current = sampleTick(keyUp(recorder.current, event.key), tick);
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);

    /**
     * The readout follows a tick derived from elapsed time, never from the frame
     * count. A frame-counted clock would write a different script on a 144 Hz display
     * than on a 60 Hz one, which is the failure this whole module is shaped to avoid.
     */
    let frame = 0;
    const tick = () => {
      const at = tickAt(performance.now() - startedAt, tickRate);
      setRecordTick(at);
      if (at >= durationTicks) {
        stopRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      cancelAnimationFrame(frame);
    };
  }, [recording, tickRate, durationTicks]);

  const update = (index: number, patch: Partial<InputEventSpec>) => {
    onChange(script.map((event, i) => (i === index ? { ...event, ...patch } : event)));
  };

  const seconds = durationTicks / Math.max(tickRate, 1);

  return (
    <section className="panel" aria-labelledby="script-heading">
      <div className="panel-head">
        <h2 id="script-heading">Input script</h2>
        {readOnly ? null : (
          <div className="panel-actions">
            <button
              type="button"
              className="ghost"
              data-testid="add-input"
              onClick={() =>
                onChange([
                  ...script,
                  {
                    tick: nextTick(script, durationTicks),
                    action: "move",
                    dxPermille: 1000,
                    dyPermille: 0,
                  },
                ])
              }
            >
              Add input
            </button>
            <button
              type="button"
              className="ghost"
              data-testid="record"
              aria-pressed={recording}
              onClick={() => (recording ? stop() : setRecording(true))}
            >
              {recording ? "Stop recording" : "Record"}
            </button>
          </div>
        )}
      </div>

      {recording ? (
        <div className="recording" data-testid="recording" role="status">
          <p>
            Recording tick <span className="tabular">{recordTick}</span> of {durationTicks}.
            Inputs are written at simulation ticks, so the script replays the same way at
            any frame rate.
          </p>
          <ul>
            {CONTROL_HINTS.map((hint) => (
              <li key={hint.keys}>
                <kbd>{hint.keys}</kbd> to {hint.does}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {script.length === 0 ? (
        <p className="state" data-testid="script-empty">
          No inputs. The body stays still for the whole run.
        </p>
      ) : (
        <div className="table-wrap script-table">
          <table>
            <caption>
              {script.length} {script.length === 1 ? "input" : "inputs"} over {durationTicks}{" "}
              ticks, {seconds.toFixed(1)} seconds at {tickRate} Hz.
            </caption>
            <thead>
              <tr>
                <th scope="col">Tick</th>
                <th scope="col">Action</th>
                <th scope="col">x</th>
                <th scope="col">y</th>
                {/* absorbs the remaining width so the data columns stay together */}
                <th scope="col" className="slack">
                  {""}
                </th>
              </tr>
            </thead>
            <tbody>
              {script.map((event, index) => (
                // index is the identity here on purpose: rows carry no id, and two
                // events can legitimately share a tick and an action while being
                // edited, so a composite key would collide mid-edit
                <tr key={index} data-testid="script-row">
                  <td>
                    <input
                      type="number"
                      aria-label={`Input ${index + 1} tick`}
                      value={event.tick}
                      min={0}
                      max={Math.max(0, durationTicks - 1)}
                      disabled={readOnly}
                      onChange={(e) => update(index, { tick: Math.trunc(Number(e.target.value)) })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Input ${index + 1} action`}
                      value={event.action}
                      disabled={readOnly}
                      onChange={(e) =>
                        update(index, { action: e.target.value as InputActionKind })
                      }
                    >
                      {INPUT_ACTIONS.map((action) => (
                        <option key={action} value={action}>
                          {ACTION_LABELS[action]}
                        </option>
                      ))}
                    </select>
                  </td>
                  {(["dxPermille", "dyPermille"] as const).map((axis) => (
                    <td key={axis}>
                      <input
                        type="number"
                        aria-label={`Input ${index + 1} ${axis === "dxPermille" ? "x" : "y"}`}
                        value={event[axis]}
                        min={-1000}
                        max={1000}
                        step={100}
                        // a stop reads neither component, so editing them would
                        // change a number the run never looks at
                        disabled={readOnly || event.action === "stop"}
                        onChange={(e) => update(index, { [axis]: Math.trunc(Number(e.target.value)) })}
                      />
                    </td>
                  ))}
                  <td className="slack">
                    {readOnly ? null : (
                      <button
                        type="button"
                        className="ghost"
                        aria-label={`Remove input ${index + 1}`}
                        onClick={() => onChange(script.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="note">
        Directions are permille, so 1000 is full deflection along that axis. A stop holds
        the body still until the next input, and the last input holds until the run ends.
      </p>
    </section>
  );
};

export default InputScriptEditor;
