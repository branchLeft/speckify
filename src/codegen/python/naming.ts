/** A PEP 503 name is already hyphen-separated lowercase; the import name just swaps hyphens for underscores. */
export function importNameFor(pep503PackageName: string): string {
  return pep503PackageName.replace(/-/g, '_');
}

/**
 * Mirrors datamodel-code-generator's default class-naming: the last JSON
 * Pointer segment of a `$ref`, PascalCased on `-`/`_`/`.` boundaries. Most
 * component schemas are already PascalCase, so this is usually the identity.
 */
export function modelNameFromRef(ref: string): string {
  const lastSegment = ref.split('/').pop() ?? ref;
  const withoutExtension = lastSegment.replace(/\.(json|ya?ml)$/i, '');
  return withoutExtension
    .split(/[-_.]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
}

/** camelCase or PascalCase operationId to snake_case, matching openapi-python-client's own function naming. */
export function snakeCase(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}
