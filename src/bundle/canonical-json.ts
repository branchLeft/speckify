/**
 * Recursively sorts object keys so that structurally identical documents
 * serialise to byte-identical JSON regardless of the order their source
 * files declared their properties in. Array order is preserved: it is
 * meaningful (e.g. `required` lists, `enum` values).
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      sorted[key] = sortKeys(entryValue);
    }
    return sorted;
  }
  return value;
}

/** Serialises `value` as deterministic, key-sorted JSON with a trailing newline. */
export function toCanonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
