import { escapePointerSegment } from '../json-pointer.js';
import { normaliseGeneratedName } from '../normalise-name.js';
import type { LintFinding } from '../types.js';

export const RULE_ID = 'operation-id';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface OpenApiDocLike {
  paths?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Requires every operation to declare an `operationId`, unique across the
 * whole document: codegen uses it as the generated method/function name, so
 * a missing or duplicate one either can't be generated or silently
 * overwrites a sibling. Two ids equal once case and separators are ignored
 * (`createThing`, `CreateThing`, `create_thing`) are duplicates too.
 */
export function checkOperationIds(doc: OpenApiDocLike): LintFinding[] {
  const findings: LintFinding[] = [];
  const firstPointerByOperationId = new Map<string, string>();
  const firstByNormalisedId = new Map<string, { operationId: string; pointer: string }>();

  if (!isRecord(doc.paths)) {
    return findings;
  }

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) {
        continue;
      }
      const pointer = `/paths/${escapePointerSegment(path)}/${method}`;
      const operationId = isRecord(operation) ? operation.operationId : undefined;

      if (typeof operationId !== 'string' || operationId === '') {
        findings.push({
          ruleId: RULE_ID,
          pointer,
          message: 'operation has no operationId',
        });
        continue;
      }

      const firstPointer = firstPointerByOperationId.get(operationId);
      const normalised = normaliseGeneratedName(operationId);
      const collision = firstByNormalisedId.get(normalised);
      if (firstPointer !== undefined) {
        findings.push({
          ruleId: RULE_ID,
          pointer: `${pointer}/operationId`,
          message: `operationId "${operationId}" is already used at ${firstPointer}; it must be unique across the document`,
        });
      } else if (collision !== undefined) {
        findings.push({
          ruleId: RULE_ID,
          pointer: `${pointer}/operationId`,
          message: `operationId "${operationId}" collides with "${collision.operationId}" at ${collision.pointer} once case and separators are ignored; the generated SDKs would give both operations one function name`,
        });
      } else {
        firstPointerByOperationId.set(operationId, `${pointer}/operationId`);
        firstByNormalisedId.set(normalised, { operationId, pointer: `${pointer}/operationId` });
      }
    }
  }

  return findings;
}
