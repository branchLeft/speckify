import { CodegenInputError } from './errors.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** A bundled OpenAPI document, typed only as far as this module reads it. */
export interface BundledSpec {
  readonly paths?: Record<string, Record<string, unknown> | undefined>;
  readonly info?: { readonly license?: unknown; readonly version?: string };
}

export interface OperationInfo {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  /** Whether the spec documents any non-2xx response for this operation. */
  readonly hasDocumentedErrors: boolean;
  /** Whether the request body content type is application/octet-stream. */
  readonly isOctetStreamBody: boolean;
  /** Whether the operation declares a request body at all. */
  readonly hasRequestBody: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Walks every path/method in the bundled spec and returns one entry per
 * operationId. Operations without an operationId are rejected up front: the
 * rest of codegen (SDK functions, Handlers methods, route ids) is keyed on
 * it, and a spec that reaches here without one has skipped the producer-side
 * contract that requires it.
 */
export function extractOperations(spec: BundledSpec): OperationInfo[] {
  const operations: OperationInfo[] = [];
  const paths = spec.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;

      const operationId = operation.operationId;
      if (typeof operationId !== 'string' || operationId.length === 0) {
        throw new CodegenInputError(
          `Operation ${method.toUpperCase()} ${path} has no operationId; every operation must declare one.`,
        );
      }

      const responses = isRecord(operation.responses) ? operation.responses : {};
      const hasDocumentedErrors = Object.keys(responses).some((status) => {
        const code = Number.parseInt(status, 10);
        return !Number.isNaN(code) && (code < 200 || code >= 300);
      });

      const requestBody = operation.requestBody;
      const content = isRecord(requestBody) && isRecord(requestBody.content) ? requestBody.content : undefined;
      const hasRequestBody = content !== undefined && Object.keys(content).length > 0;
      const isOctetStreamBody = content !== undefined && 'application/octet-stream' in content;

      operations.push({ operationId, method, path, hasDocumentedErrors, isOctetStreamBody, hasRequestBody });
    }
  }

  return operations;
}
