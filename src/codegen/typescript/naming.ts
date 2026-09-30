/**
 * Naming helpers matching @hey-api/openapi-ts's default casing convention, so
 * generated code can reference its type and zod-schema exports by name
 * without parsing the files it wrote.
 */

/**
 * Splits an identifier on camelCase, snake_case, kebab-case and space
 * boundaries alike, so operationIds written in any of those styles land on
 * the same PascalCase hey-api itself would produce.
 */
function splitWords(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word.length > 0);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** e.g. `getThing` / `get_thing` / `get-thing` -> `GetThing`. */
export function toPascalCase(operationId: string): string {
  return splitWords(operationId).map(capitalize).join('');
}

/** e.g. `getThing` / `get_thing` -> `getThing`. hey-api's SDK function name. */
export function toCamelCase(operationId: string): string {
  const pascal = toPascalCase(operationId);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
