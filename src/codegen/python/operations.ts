import { modelNameFromRef, snakeCase } from './naming.js';
import type { OperationInfo, ParamInfo, RequestBodyInfo, ResponseInfo } from './types.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface RawSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  [key: string]: unknown;
}

interface RawParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: RawSchema;
}

interface RawMediaType {
  schema?: RawSchema;
}

interface RawRequestBody {
  required?: boolean;
  content?: Record<string, RawMediaType>;
}

interface RawResponse {
  content?: Record<string, RawMediaType>;
}

interface RawOperation {
  operationId?: string;
  parameters?: RawParameter[];
  requestBody?: RawRequestBody;
  responses?: Record<string, RawResponse>;
}

interface RawDocument {
  paths?: Record<string, Record<string, RawOperation>>;
}

/** Every schema shape this module's templates can represent falls back to `str` rather than failing generation. */
function pyTypeForSchema(schema: RawSchema | undefined): string {
  const type = schema?.type;
  const primary = Array.isArray(type) ? type.find((t) => t !== 'null') : type;
  switch (primary) {
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    default:
      // Includes `string` regardless of `format`: a header or query value is
      // always transmitted as a string, and parsing (e.g. date-time) is a
      // handler concern, not something the wire shape can decide for it.
      return 'str';
  }
}

function toParamInfo(parameter: RawParameter): ParamInfo {
  return {
    name: parameter.name,
    pyName: snakeCase(parameter.name.replace(/^X-/i, '')),
    required: parameter.required ?? false,
    pyType: pyTypeForSchema(parameter.schema),
  };
}

function toRequestBodyInfo(requestBody: RawRequestBody | undefined): RequestBodyInfo {
  if (!requestBody?.content) {
    return { kind: 'none' };
  }
  const required = requestBody.required ?? false;
  const json = requestBody.content['application/json'];
  if (json?.schema?.$ref !== undefined) {
    return { kind: 'json', required, model: modelNameFromRef(json.schema.$ref) };
  }
  if (requestBody.content['application/octet-stream'] !== undefined) {
    return { kind: 'octet-stream', required };
  }
  return { kind: 'none' };
}

function toResponseInfos(responses: Record<string, RawResponse> | undefined): ResponseInfo[] {
  if (!responses) {
    return [];
  }
  return Object.entries(responses).map(([statusCode, response]) => {
    const ref = response.content?.['application/json']?.schema?.$ref;
    return { statusCode, model: ref !== undefined ? modelNameFromRef(ref) : null };
  });
}

/**
 * Extracts the per-operation shape the completeness guard and the server
 * generator both need from a bundled OpenAPI document (already parsed from
 * the canonical JSON `bundleSpec` produces).
 */
export function extractOperations(document: unknown): OperationInfo[] {
  const doc = document as RawDocument;
  const operations: OperationInfo[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.operationId) {
        continue;
      }
      const parameters = operation.parameters ?? [];
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        pathParams: parameters.filter((p) => p.in === 'path').map(toParamInfo),
        queryParams: parameters.filter((p) => p.in === 'query').map(toParamInfo),
        headerParams: parameters.filter((p) => p.in === 'header').map(toParamInfo),
        requestBody: toRequestBodyInfo(operation.requestBody),
        responses: toResponseInfos(operation.responses),
      });
    }
  }

  return operations;
}
