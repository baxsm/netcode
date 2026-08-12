import type { FC } from "react";
import {
  TECHNIQUE_FIELDS,
  TECHNIQUE_LABELS,
  type NetcodeConfig,
  type TechniqueField,
} from "../sim/types";

interface ConfigStripProps {
  config: NetcodeConfig;
}

/**
 * The constants worth reading at a glance while watching the replay.
 *
 * These are the three the sweep varies, so a configuration opened from the tune page
 * shows the values that were actually chosen. Rollback window and rewind limit are
 * left out: neither changes what this scenario does, so printing them next to motion
 * they cannot affect would imply they were part of the result.
 */
const CONSTANTS: Array<{ label: string; read: (c: NetcodeConfig) => string }> = [
  { label: "input buffer", read: (c) => `${c.inputBufferTicks} ticks` },
  { label: "blend", read: (c) => `${c.correctionBlendPermille / 10}%` },
  { label: "snap", read: (c) => `${(c.snapThresholdPermille / 1000).toFixed(1)} units` },
  { label: "interp delay", read: (c) => `${c.interpolationDelayTicks} ticks` },
];

/**
 * What is running, compact and always visible.
 *
 * A technique that is off is shown struck through rather than removed, so the strip
 * keeps a stable width and reads as a set with something missing rather than as a
 * shorter list.
 */
const ConfigStrip: FC<ConfigStripProps> = ({ config }) => (
  <div className="config-strip" data-testid="config-strip">
    <ul className="strip-techniques">
      {TECHNIQUE_FIELDS.map((field: TechniqueField) => (
        <li key={field} className={config.techniques[field] ? "on" : "off"}>
          {TECHNIQUE_LABELS[field]}
        </li>
      ))}
    </ul>
    <ul className="strip-constants">
      {CONSTANTS.map(({ label, read }) => (
        <li key={label}>
          <span className="muted">{label}</span> {read(config)}
        </li>
      ))}
    </ul>
  </div>
);

export default ConfigStrip;
