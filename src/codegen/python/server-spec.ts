import { toCanonicalJson } from '../../bundle/canonical-json.js';
import { modelNameFromRef } from './naming.js';

type Json = Record<string, unknown>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveLocal(doc: Json, value: unknown): unknown {
  if (!isObject(value) || typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) {
    return value;
  }
  let node: unknown = doc;
  for (const raw of value.$ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = isObject(node) ? node[key] : undefined;
  }
  return node ?? value;
}

function parameterKey(parameter: unknown): string {
  return isObject(parameter) ? `${String(parameter.in)}:${String(parameter.name)}` : '';
}

function pascalCase(identifier: string): string {
  return identifier
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
}

/** A component-schema name for `operationId`'s body, unique once PascalCased as the model name. */
function bodyModelName(operationId: string, schemas: Json): string {
  const taken = new Set(Object.keys(schemas).map((name) => modelNameFromRef(name)));
  const base = `${pascalCase(operationId)}RequestBody`;
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) {
    name = `${base}${String(suffix)}`;
  }
  return name;
}

/**
 * The spec the Python models and server are generated from: operation
 * parameters and request bodies resolved, path-level parameters merged,
 * and inline JSON body schemas hoisted into named models. See
 * docs/server-boilerplate.md.
 */
export function prepareServerSpec(bundledSpec: string): string {
  const doc = JSON.parse(bundledSpec) as Json;
  const components = isObject(doc.components) ? doc.components : {};
  const schemas = isObject(components.schemas) ? { ...components.schemas } : {};
  const paths = isObject(doc.paths) ? doc.paths : {};
  let hoisted = false;

  for (const pathItem of Object.values(paths)) {
    if (!isObject(pathItem)) continue;
    const shared: unknown[] = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;
      const own: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
      const merged = new Map<string, unknown>();
      for (const parameter of [...shared, ...own].map((p) => resolveLocal(doc, p))) {
        merged.set(parameterKey(parameter), parameter);
      }
      if (merged.size > 0) operation.parameters = [...merged.values()];

      const resolved = resolveLocal(doc, operation.requestBody);
      if (!isObject(resolved)) continue;
      const body = { ...resolved };
      operation.requestBody = body;
      const json = isObject(body.content) ? body.content['application/json'] : undefined;
      if (!isObject(json) || !isObject(json.schema) || typeof json.schema.$ref === 'string') {
        continue;
      }
      const operationId =
        typeof operation.operationId === 'string' ? operation.operationId : method;
      const name = bodyModelName(operationId, schemas);
      schemas[name] = json.schema;
      hoisted = true;
      body.content = {
        ...(body.content as Json),
        'application/json': { ...json, schema: { $ref: `#/components/schemas/${name}` } },
      };
    }
  }

  if (hoisted) doc.components = { ...components, schemas };
  return toCanonicalJson(doc);
}
