import type { BundledSpec } from '../../bundle/index.js';
import { CodegenInputError } from './errors.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

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
  readonly hasPathParams: boolean;
  readonly hasQueryParams: boolean;
  readonly hasHeaderParams: boolean;
  /**
   * The first documented 2xx status with a JSON schema, if any. hey-api
   * only emits a `z{Pascal}Response` validator for this case; a second
   * documented success status (not exercised by any fixture) would have no
   * generated validator and is left unvalidated at runtime.
   */
  readonly successStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True when at least one media type under `content` declares a `schema`.
 * A response can carry `content` with only `examples` and no `schema` (a
 * real OAI example, api-with-examples.yaml, does exactly this) — hey-api's
 * zod plugin emits no validator for that, so treating the response as
 * schema-bearing makes the generated server import a validator that was
 * never generated.
 */
function hasSchemaContent(content: unknown): boolean {
  return (
    isRecord(content) && Object.values(content).some((v) => isRecord(v) && v.schema !== undefined)
  );
}

/**
 * True when a response's `content` is present but none of its media types
 * declare a `schema` (only `examples`, say). hey-api's type plugin collapses
 * *every* response on the operation to a bare `unknown` (no discriminated
 * `{Pascal}Responses`/`{Pascal}Errors`) when every single response is like
 * this — but a response with no `content` at all does not count: paired
 * with even one bare response, or one that does have a schema, hey-api
 * still emits the discriminated types normally. Verified against the real
 * generator's output (see operations.test.ts), not inferred from the spec.
 */
function blocksDiscriminatedTyping(content: unknown): boolean {
  return isRecord(content) && !hasSchemaContent(content);
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
      let hasNonSuccessStatus = false;
      let everyResponseBlocksTyping = true;
      let successStatus: number | undefined;
      for (const [status, responseDef] of Object.entries(responses)) {
        const code = Number.parseInt(status, 10);
        if (Number.isNaN(code)) continue;
        const content = isRecord(responseDef) ? responseDef.content : undefined;
        if (!blocksDiscriminatedTyping(content)) {
          everyResponseBlocksTyping = false;
        }
        if (code < 200 || code >= 300) {
          hasNonSuccessStatus = true;
          continue;
        }
        if (successStatus === undefined && hasSchemaContent(content)) {
          successStatus = code;
        }
      }
      // hey-api collapses every response on an operation to a bare
      // `unknown` — no discriminated `{Pascal}Responses`/`{Pascal}Errors` —
      // when every single response's `content` lacks a `schema`
      // (api-with-examples.yaml documents its responses with `examples`
      // only). Importing an `Errors` type unconditionally whenever a
      // non-2xx status exists then references a type hey-api never
      // generated. Caught by the OAI corpus (src/e2e/corpus.test.ts).
      const hasDocumentedErrors = hasNonSuccessStatus && !everyResponseBlocksTyping;

      const requestBody = operation.requestBody;
      const content =
        isRecord(requestBody) && isRecord(requestBody.content) ? requestBody.content : undefined;
      const hasRequestBody = content !== undefined && Object.keys(content).length > 0;
      const isOctetStreamBody = content !== undefined && 'application/octet-stream' in content;

      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const hasPathParams = parameters.some((p) => isRecord(p) && p.in === 'path');
      const hasQueryParams = parameters.some((p) => isRecord(p) && p.in === 'query');
      const hasHeaderParams = parameters.some((p) => isRecord(p) && p.in === 'header');

      operations.push({
        operationId,
        method,
        path,
        hasDocumentedErrors,
        isOctetStreamBody,
        hasRequestBody,
        hasPathParams,
        hasQueryParams,
        hasHeaderParams,
        ...(successStatus === undefined ? {} : { successStatus }),
      });
    }
  }

  return operations;
}
