import { IncompleteGenerationError } from './errors.js';
import { toCamelCase } from './naming.js';
import type { OperationInfo } from './operations.js';

/**
 * Confirms every spec operation has a generated SDK function and, when the
 * package includes a server, a Handlers method — both keyed by the
 * camelCase form of its operationId. Generators have silently dropped
 * endpoints before; this turns that into a build failure that names exactly
 * what is missing, rather than a package that quietly serves less than the
 * spec documents.
 */
export function assertGenerationComplete(
  operations: readonly OperationInfo[],
  generated: {
    readonly sdkFunctionNames: ReadonlySet<string>;
    readonly handlerMethodNames?: ReadonlySet<string>;
  },
): void {
  const missingSdk = operations
    .map((op) => toCamelCase(op.operationId))
    .filter((name) => !generated.sdkFunctionNames.has(name));

  const missingHandlers = generated.handlerMethodNames
    ? operations
        .map((op) => toCamelCase(op.operationId))
        .filter((name) => !generated.handlerMethodNames?.has(name))
    : [];

  const missing = [...new Set([...missingSdk, ...missingHandlers])];
  if (missing.length > 0) {
    throw new IncompleteGenerationError(
      `Generation is missing ${missing.length.toString()} operation(s) from the SDK or server: ${missing.join(', ')}`,
      missing,
    );
  }
}
