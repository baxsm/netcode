import type { FC } from "react";
import {
  TECHNIQUE_FIELDS,
  TECHNIQUE_LABELS,
  type NetcodeConfig,
  type TechniqueField,
} from "../sim/types";

interface ConfigStripProps {
  config: NetcodeConfig;
  /** True when the scenario fires, which is what makes the rewind limit act. */
  firesShots: boolean;
}

/**
 * The constants worth reading at a glance while watching the replay.
 *
 * A constant appears only where it can change what is on screen. Printing one next to
 * motion it cannot affect would imply it was part of the result, which is how the
 * input buffer went four phases carried, hashed and never read.
 *
 * The rewind limit is the case that varies: it only resolves shots, so it appears for
 * a scenario that fires and is left out of one that does not.
 */
const CONSTANTS: Array<{
  label: string;
  read: (c: NetcodeConfig) => string;
  needsShots?: boolean;
}> = [
  { label: "input buffer", read: (c) => `${c.inputBufferTicks} ticks` },
  { label: "blend", read: (c) => `${c.correctionBlendPermille / 10}%` },
  { label: "snap", read: (c) => `${(c.snapThresholdPermille / 1000).toFixed(1)} units` },
  { label: "interp delay", read: (c) => `${c.interpolationDelayTicks} ticks` },
  { label: "rewind limit", read: (c) => `${c.serverRewindLimitMs} ms`, needsShots: true },
];

/**
 * What is running, compact and always visible.
 *
 * A technique that is off is shown struck through rather than removed, so the strip
 * keeps a stable width and reads as a set with something missing rather than as a
 * shorter list.
 */
const ConfigStrip: FC<ConfigStripProps> = ({ config, firesShots }) => (
  <div className="config-strip" data-testid="config-strip">
    <ul className="strip-techniques">
      {TECHNIQUE_FIELDS.map((field: TechniqueField) => (
        <li key={field} className={config.techniques[field] ? "on" : "off"}>
          {TECHNIQUE_LABELS[field]}
        </li>
      ))}
    </ul>
    <ul className="strip-constants">
      {CONSTANTS.filter(({ needsShots }) => !needsShots || firesShots).map(({ label, read }) => (
        <li key={label}>
          <span className="muted">{label}</span> {read(config)}
        </li>
      ))}
    </ul>
  </div>
);

export default ConfigStrip;
