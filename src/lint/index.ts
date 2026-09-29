import { LintError } from './errors.js';
import { checkNoPatternProperties } from './rules/no-pattern-properties.js';
import { checkOperationIds } from './rules/operation-id.js';
import { checkOpenApiVersion } from './rules/openapi-version.js';
import type { LintFinding } from './types.js';

/** Runs every Speckify lint rule against a parsed bundled document. */
export function lintDocument(doc: unknown): LintFinding[] {
  const docRecord = doc !== null && typeof doc === 'object' ? doc : {};

  return [
    ...checkOpenApiVersion(docRecord),
    ...checkOperationIds(docRecord),
    ...checkNoPatternProperties(doc),
  ];
}

/**
 * Lints a bundled spec (the canonical JSON string {@link bundleSpec}
 * produces) and throws {@link LintError} if any rule finds a problem.
 *
 * @throws {LintError} if linting finds one or more problems.
 */
export function lintBundledSpec(bundledSpecJson: string): void {
  const doc: unknown = JSON.parse(bundledSpecJson);
  const findings = lintDocument(doc);
  if (findings.length > 0) {
    throw new LintError(findings);
  }
}

export { LintError } from './errors.js';
export type { LintFinding } from './types.js';
