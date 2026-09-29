import type { LintFinding } from './types.js';

function renderFindings(findings: readonly LintFinding[]): string {
  return findings
    .map((finding) => `[${finding.ruleId}] ${finding.pointer}: ${finding.message}`)
    .join('\n');
}

/**
 * Raised when a bundled spec fails one or more Speckify lint rules. Carries
 * every finding, not just the first, so a failing `check`/`plan` reports
 * the whole set in one pass.
 */
export class LintError extends Error {
  public readonly findings: LintFinding[];

  public constructor(findings: readonly LintFinding[]) {
    super(`the bundled spec failed Speckify lint:\n${renderFindings(findings)}`);
    this.name = 'LintError';
    this.findings = [...findings];
  }
}
