import { modelNameFromRef, snakeCase } from './naming.js';
import type {
  OperationInfo,
  ParamConstraints,
  ParamInfo,
  RequestBodyInfo,
  ResponseInfo,
} from './types.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface RawSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  items?: RawSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
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

function primaryType(schema: RawSchema | undefined): string | undefined {
  const type = schema?.type;
  return Array.isArray(type) ? type.find((t) => t !== 'null') : type;
}

/** Every schema shape this module's templates can represent falls back to `str` rather than failing generation. */
function pyTypeForSchema(schema: RawSchema | undefined): string {
  switch (primaryType(schema)) {
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

/** Only JSON-primitive enum members are representable in the runtime check; anything else is left unenforced rather than failing generation. */
function enumConstraint(
  schema: RawSchema | undefined,
): readonly (string | number | boolean)[] | undefined {
  const values = schema?.enum?.filter(
    (v): v is string | number | boolean =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
  return values && values.length > 0 ? values : undefined;
}

/**
 * The runtime equivalent of the `pydantic.Field` constraints
 * datamodel-code-generator would bake into a named model, for a bare
 * query/path/header parameter (which has no model of its own): oasdiff's
 * classification map already treats a tightened minimum/maximum/pattern/
 * enum as a breaking change on the request side, so the generated server
 * enforcing them for real is what makes that classification meaningful
 * rather than just a promise about the spec text.
 */
function constraintsForSchema(schema: RawSchema | undefined): ParamConstraints {
  const constraints: ParamConstraints = {};
  const enumValues = enumConstraint(schema);
  if (enumValues !== undefined) constraints.enum = enumValues;
  if (typeof schema?.minimum === 'number') constraints.minimum = schema.minimum;
  if (typeof schema?.maximum === 'number') constraints.maximum = schema.maximum;
  if (typeof schema?.exclusiveMinimum === 'number') {
    constraints.exclusiveMinimum = schema.exclusiveMinimum;
  }
  if (typeof schema?.exclusiveMaximum === 'number') {
    constraints.exclusiveMaximum = schema.exclusiveMaximum;
  }
  if (typeof schema?.minLength === 'number') constraints.minLength = schema.minLength;
  if (typeof schema?.maxLength === 'number') constraints.maxLength = schema.maxLength;
  if (typeof schema?.pattern === 'string') constraints.pattern = schema.pattern;
  return constraints;
}

function toParamInfo(parameter: RawParameter): ParamInfo {
  const schema = parameter.schema;
  const isArray = primaryType(schema) === 'array';
  // The schema that actually governs each transmitted value: the array's
  // `items` schema for an array parameter (query params repeat the same
  // key, each occurrence one item), the parameter's own schema otherwise.
  const valueSchema = isArray ? schema?.items : schema;
  return {
    name: parameter.name,
    pyName: snakeCase(parameter.name.replace(/^X-/i, '')),
    required: parameter.required ?? false,
    pyType: pyTypeForSchema(valueSchema),
    isArray,
    constraints: constraintsForSchema(valueSchema),
  };
}

function toRequestBodyInfo(requestBody: RawRequestBody | undefined): RequestBodyInfo {
  if (!requestBody?.content) {
    return { kind: 'none' };
  }
  const required = requestBody.required ?? false;
  const json = requestBody.content['application/json'];
  if (json !== undefined) {
    const ref = json.schema?.$ref;
    // An inline (non-$ref) JSON body schema has no generated pydantic
    // model to bind to -- `model: null` tells the router to parse and pass
    // the JSON value through unvalidated by a model, rather than falling
    // through to `{ kind: 'none' }` and silently dropping the body.
    return { kind: 'json', required, model: ref !== undefined ? modelNameFromRef(ref) : null };
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
