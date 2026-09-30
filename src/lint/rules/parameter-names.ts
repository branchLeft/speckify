import { escapePointerSegment } from '../json-pointer.js';
import { normaliseGeneratedName } from '../normalise-name.js';
import type { LintFinding } from '../types.js';

export const RULE_ID = 'parameter-names';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Doc = Record<string, unknown>;

interface ParameterEntry {
  readonly name: string;
  readonly location: string;
  readonly pointer: string;
  readonly operationLevel: boolean;
}

function isRecord(value: unknown): value is Doc {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Follows one local `#/components/parameters/<name>` reference; anything else is returned as is. */
function resolveParameter(doc: Doc, value: unknown): unknown {
  if (!isRecord(value) || typeof value.$ref !== 'string') return value;
  const prefix = '#/components/parameters/';
  if (!value.$ref.startsWith(prefix)) return undefined;
  const components = isRecord(doc.components) ? doc.components.parameters : undefined;
  return isRecord(components) ? components[value.$ref.slice(prefix.length)] : undefined;
}

function readEntries(
  doc: Doc,
  list: unknown,
  pointer: string,
  operationLevel: boolean,
): ParameterEntry[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw, index) => {
    const parameter = resolveParameter(doc, raw);
    if (!isRecord(parameter) || typeof parameter.name !== 'string') return [];
    return [
      {
        name: parameter.name,
        location: String(parameter.in),
        pointer: `${pointer}/parameters/${String(index)}`,
        operationLevel,
      },
    ];
  });
}

function sameParameter(a: ParameterEntry, b: ParameterEntry): boolean {
  return a.name === b.name && a.location === b.location;
}

/** Reports each entry whose normalised name an earlier, different entry already holds. */
function collisions(entries: readonly ParameterEntry[], report: boolean[]): LintFinding[] {
  const seen = new Map<string, ParameterEntry>();
  const findings: LintFinding[] = [];
  entries.forEach((entry, index) => {
    const key = normaliseGeneratedName(entry.name);
    const earlier = seen.get(key);
    if (earlier === undefined) {
      seen.set(key, entry);
    } else if (report[index] === true) {
      findings.push({
        ruleId: RULE_ID,
        pointer: entry.pointer,
        message: `parameter "${entry.name}" (${entry.location}) collides with "${earlier.name}" (${earlier.location}) once case and separators are ignored; the generated Python client would rename both keyword arguments`,
      });
    }
  });
  return findings;
}

/**
 * Refuses two parameters of one operation whose names are equal once case
 * and separators are ignored, such as a `Page-Size` header beside a
 * `page_size` query parameter, or a query `id` beside a path `id`.
 * openapi-python-client gives every parameter one keyword argument, so it
 * suffixes both colliding names with their location: adding the second
 * one renames the first, and existing calls stop working.
 */
export function checkParameterNames(doc: Doc): LintFinding[] {
  const findings: LintFinding[] = [];
  if (!isRecord(doc.paths)) return findings;

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!isRecord(pathItem)) continue;
    const pathPointer = `/paths/${escapePointerSegment(path)}`;
    const pathEntries = readEntries(doc, pathItem.parameters, pathPointer, false);
    findings.push(
      ...collisions(
        pathEntries,
        pathEntries.map(() => true),
      ),
    );

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const own = readEntries(doc, operation.parameters, `${pathPointer}/${method}`, true);
      const inherited = pathEntries.filter((entry) => !own.some((o) => sameParameter(o, entry)));
      const merged = [...inherited, ...own];
      findings.push(
        ...collisions(
          merged,
          merged.map((entry) => entry.operationLevel),
        ),
      );
    }
  }
  return findings;
}
