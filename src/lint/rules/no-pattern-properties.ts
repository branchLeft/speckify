import { walkJson } from '../json-pointer.js';
import type { LintFinding } from '../types.js';

export const RULE_ID = 'no-pattern-properties';

/**
 * Refuses `patternProperties` anywhere in the document. Every generator in
 * Speckify's conformance spike (hey-api's zod plugin, openapi-python-client,
 * datamodel-code-generator) silently drops it, keeping only explicitly
 * declared properties — a schema that relies on it for anything load-bearing
 * would generate code that quietly loses data.
 */
export function checkNoPatternProperties(doc: unknown): LintFinding[] {
  const findings: LintFinding[] = [];

  walkJson(doc, '', (value, pointer) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'patternProperties')) {
      findings.push({
        ruleId: RULE_ID,
        pointer: `${pointer}/patternProperties`,
        message:
          'patternProperties is silently dropped by every generator Speckify targets; use "additionalProperties: <schema>" instead.',
      });
    }
  });

  return findings;
}
