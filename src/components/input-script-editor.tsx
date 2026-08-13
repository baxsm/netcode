import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import { Circle, Plus, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
    <Card aria-labelledby="script-heading">
      <CardHeader>
        <CardTitle id="script-heading">Input script</CardTitle>
        <CardDescription>
          What the body is told to do, written at simulation ticks so it replays the
          same way at any frame rate.
        </CardDescription>
        {readOnly ? null : (
          <CardAction>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
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
                <Plus data-icon="inline-start" />
                Add input
              </Button>
              {/* while recording this is the only thing worth clicking, and every
                  keystroke is being written, so it stops reading as one option among
                  several. fixed width because the label swaps between "Record" and
                  "Stop recording", which is an eight character difference */}
              <Button
                variant={recording ? "default" : "outline"}
                size="sm"
                className="w-[8.25rem]"
                data-testid="record"
                aria-pressed={recording}
                onClick={() => (recording ? stop() : setRecording(true))}
              >
                {recording ? (
                  <Square className="fill-current" data-icon="inline-start" />
                ) : (
                  <Circle className="fill-current" data-icon="inline-start" />
                )}
                {recording ? "Stop recording" : "Record"}
              </Button>
            </div>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {recording ? (
          <div
            className="space-y-2 rounded-lg border border-primary/50 bg-primary/5 px-3 py-2.5"
            data-testid="recording"
            role="status"
          >
            <p className="flex items-center gap-2 text-sm">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              Recording tick <span className="tabular">{recordTick}</span> of{" "}
              {durationTicks}.
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {CONTROL_HINTS.map((hint) => (
                <li
                  key={hint.keys}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <kbd className="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground">
                    {hint.keys}
                  </kbd>
                  to {hint.does}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {script.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="script-empty">
            No inputs. The body stays still for the whole run.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableCaption className="mt-0 mb-2 text-left">
                {script.length} {script.length === 1 ? "input" : "inputs"} over{" "}
                {durationTicks} ticks, {seconds.toFixed(1)} seconds at {tickRate} Hz.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Tick</TableHead>
                  <TableHead className="w-36">Action</TableHead>
                  <TableHead className="w-28">x</TableHead>
                  <TableHead className="w-28">y</TableHead>
                  {/* absorbs the remaining width so the data columns stay together */}
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {script.map((event, index) => (
                  // index is the identity here on purpose: rows carry no id, and two
                  // events can legitimately share a tick and an action while being
                  // edited, so a composite key would collide mid-edit
                  <TableRow key={index} data-testid="script-row">
                    <TableCell>
                      <Input
                        type="number"
                        className="tabular h-7 w-20"
                        aria-label={`Input ${index + 1} tick`}
                        value={event.tick}
                        min={0}
                        max={Math.max(0, durationTicks - 1)}
                        disabled={readOnly}
                        onChange={(e) =>
                          update(index, { tick: Math.trunc(Number(e.target.value)) })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={event.action}
                        disabled={readOnly}
                        onValueChange={(v) => {
                          if (typeof v === "string") {
                            update(index, { action: v as InputActionKind });
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-28"
                          aria-label={`Input ${index + 1} action`}
                        >
                          <SelectValue>{() => ACTION_LABELS[event.action]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {INPUT_ACTIONS.map((action) => (
                            <SelectItem key={action} value={action}>
                              {ACTION_LABELS[action]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    {(["dxPermille", "dyPermille"] as const).map((axis) => (
                      <TableCell key={axis}>
                        <Input
                          type="number"
                          className="tabular h-7 w-20"
                          aria-label={`Input ${index + 1} ${axis === "dxPermille" ? "x" : "y"}`}
                          value={event[axis]}
                          min={-1000}
                          max={1000}
                          step={100}
                          // a stop reads neither component, so editing them would
                          // change a number the run never looks at
                          disabled={readOnly || event.action === "stop"}
                          onChange={(e) =>
                            update(index, { [axis]: Math.trunc(Number(e.target.value)) })
                          }
                        />
                      </TableCell>
                    ))}
                    <TableCell>
                      {readOnly ? null : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove input ${index + 1}`}
                                onClick={() =>
                                  onChange(script.filter((_, i) => i !== index))
                                }
                              >
                                <Trash2 />
                              </Button>
                            }
                          />
                          <TooltipContent>Remove this input</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Directions are permille, so 1000 is full deflection along that axis. A stop
          holds the body still until the next input, and the last input holds until the
          run ends.
        </p>
      </CardContent>
    </Card>
  );
};

export default InputScriptEditor;
