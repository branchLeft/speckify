import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CompletenessGuardError } from './errors.js';
import { snakeCase } from './naming.js';
import type { OperationInfo } from './types.js';

/**
 * openapi-python-client writes one module per operation under `api/**`,
 * named after the operationId snake-cased (e.g. `getThing` -> `get_thing.py`).
 * This walks the generated `api/` tree once and returns the set of module
 * stems it finds, rather than assuming a fixed tag layout.
 */
async function collectGeneratedOperationModules(apiDir: string): Promise<Set<string>> {
  const stems = new Set<string>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.name.endsWith('.py') && entry.name !== '__init__.py') {
        stems.add(entry.name.slice(0, -'.py'.length));
      }
    }
  }

  await walk(apiDir);
  return stems;
}

/**
 * Fails loudly, naming every missing operationId, when the client
 * openapi-python-client 0.29.1 generated is missing a function for an
 * operation the spec declares. This is the guard against that generator's
 * known behaviour of silently skipping an endpoint it cannot handle (most
 * commonly a header parameter with `format: date-time`) instead of erroring.
 *
 * @throws {CompletenessGuardError} naming every missing operationId.
 */
export async function assertClientCompleteness(
  operations: readonly OperationInfo[],
  clientDir: string,
): Promise<void> {
  const generatedStems = await collectGeneratedOperationModules(join(clientDir, 'api'));
  const missing = operations
    .map((operation) => operation.operationId)
    .filter((operationId) => !generatedStems.has(snakeCase(operationId)));

  if (missing.length > 0) {
    throw new CompletenessGuardError(missing);
  }
}
