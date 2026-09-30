import path from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * Reads the SDK function names @hey-api/openapi-ts actually emitted, by
 * parsing its own output rather than trusting the operation list codegen
 * started from — the completeness guard exists precisely because a
 * generator can drop an operation silently.
 */
export async function readSdkFunctionNames(srcDir: string): Promise<Set<string>> {
  const text = await readFile(path.join(srcDir, 'sdk.gen.ts'), 'utf8');
  return new Set([...text.matchAll(/export const (\w+) =/g)].map((match) => match[1] ?? ''));
}

/** Reads the Handlers method names Speckify's own server generator emitted. */
export async function readHandlerMethodNames(srcDir: string): Promise<Set<string>> {
  const text = await readFile(path.join(srcDir, 'handlers.gen.ts'), 'utf8');
  return new Set([...text.matchAll(/^ {2}(\w+)\(/gm)].map((match) => match[1] ?? ''));
}
