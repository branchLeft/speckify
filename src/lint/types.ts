/**
 * One thing a lint rule found wrong with a bundled document. `pointer` is
 * an RFC 6901 JSON pointer into the document, so a finding can be traced
 * back to the exact place that caused it, not just "somewhere in the spec".
 */
export interface LintFinding {
  ruleId: string;
  pointer: string;
  message: string;
}
