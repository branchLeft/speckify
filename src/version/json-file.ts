import { readFile } from 'node:fs/promises';

import { VersionError } from './errors.js';

/**
 * Reads and JSON-parses a file, wrapping both a missing/unreadable file and
 * invalid JSON in {@link VersionError} so callers don't need to distinguish
 * fs errors from parse errors.
 *
 * @throws {VersionError} if the file cannot be read, or is not valid JSON.
 */
export async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VersionError(`could not read ${filePath}: ${reason}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VersionError(`${filePath} is not valid JSON: ${reason}`);
  }
}
