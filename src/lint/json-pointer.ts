/** Escapes one path segment per RFC 6901: `~` first, then `/`. */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Depth-first walks a parsed JSON value, calling `visit` with every node
 * (including the root) and the RFC 6901 pointer that reaches it. Rules use
 * this instead of hand-rolled recursion so every finding's pointer is
 * built the same way.
 */
export function walkJson(
  value: unknown,
  pointer: string,
  visit: (value: unknown, pointer: string) => void,
): void {
  visit(value, pointer);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkJson(item, `${pointer}/${String(index)}`, visit);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkJson(child, `${pointer}/${escapePointerSegment(key)}`, visit);
    }
  }
}
