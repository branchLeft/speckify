/**
 * The form two generated names are compared in: lower case, with every
 * character that is not a letter or digit removed. hey-api camel-cases and
 * openapi-python-client snake-cases, and both only change case and
 * separators, so two names equal here can become one generated identifier.
 */
export function normaliseGeneratedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
