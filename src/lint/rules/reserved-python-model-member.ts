import { pythonIdentifier } from '../../codegen/python/naming.js';
import { escapePointerSegment, walkJson } from '../json-pointer.js';
import {
  OPENAPI_PYTHON_CLIENT_MODEL_MEMBERS,
  OPENAPI_PYTHON_CLIENT_RESERVED_WORDS,
} from '../reserved-python-names.js';
import type { LintFinding } from '../types.js';

export const RULE_ID = 'reserved-python-model-member';

const FIELD_PREFIX = 'field_';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Refuses a property whose generated Python name (real `PythonIdentifier`
 * sanitisation, see `../../codegen/python/naming.ts`) collides with a member
 * openapi-python-client's own attrs model template always defines
 * (`../reserved-python-names.ts`): the new attrs field shadows it outright,
 * so e.g. `instance.to_dict()` raises `TypeError` the moment it ships —
 * a break oasdiff/the surface diff would otherwise pass as minor.
 */
export function checkReservedPythonModelMembers(doc: unknown): LintFinding[] {
  const findings: LintFinding[] = [];

  // Any object with a `properties` map, not only named
  // `components.schemas` entries: an inline body object gets a model too.
  walkJson(doc, '', (value, pointer) => {
    if (!isRecord(value) || !isRecord(value.properties)) return;

    for (const name of Object.keys(value.properties)) {
      const pythonName = pythonIdentifier(name, FIELD_PREFIX, OPENAPI_PYTHON_CLIENT_RESERVED_WORDS);
      if (!OPENAPI_PYTHON_CLIENT_MODEL_MEMBERS.has(pythonName)) continue;
      findings.push({
        ruleId: RULE_ID,
        pointer: `${pointer}/properties/${escapePointerSegment(name)}`,
        message:
          `property "${name}" generates the Python attribute "${pythonName}", which collides with a ` +
          "member openapi-python-client's own model template already defines on every generated " +
          `class (${[...OPENAPI_PYTHON_CLIENT_MODEL_MEMBERS].sort().join(', ')}); adding it would ` +
          'shadow that member, breaking every existing call to it at runtime.',
      });
    }
  });

  return findings;
}
