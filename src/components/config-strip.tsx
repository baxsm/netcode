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

/** The constants worth reading at a glance while watching the replay. */
const CONSTANTS: Array<{ label: string; read: (c: NetcodeConfig) => string }> = [
  { label: "interp delay", read: (c) => `${c.interpolationDelayTicks} ticks` },
  { label: "rollback window", read: (c) => `${c.rollbackWindowTicks} ticks` },
  { label: "blend", read: (c) => `${c.correctionBlendPermille / 10}%` },
  { label: "rewind limit", read: (c) => `${c.serverRewindLimitMs} ms` },
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
