import type { FC } from "react";
import Icon from "./icon";

interface VerdictProps {
  passed: boolean;
  children: string;
  /** Only the panel-level verdicts are addressed by tests, so most sites pass nothing. */
  testId?: string;
}

/**
 * A pass or fail, wherever one is shown.
 *
 * The word carries the result and the colour reinforces it, never the reverse, so the
 * glyph is a third channel rather than the only one: a reader who cannot separate the
 * green from the amber still has the tick against the cross, and both against the text.
 */
const Verdict: FC<VerdictProps> = ({ passed, children, testId }) => (
  <span className={passed ? "verdict pass" : "verdict fail"} data-testid={testId}>
    <Icon name={passed ? "check" : "cross"} />
    {children}
  </span>
);

export default Verdict;
