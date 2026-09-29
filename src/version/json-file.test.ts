import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VersionError } from './errors.js';
import { readJsonFile } from './json-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('readJsonFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speckify-json-file-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.mocked(readFile).mockRestore();
  });

  it('parses a well-formed JSON file', async () => {
    const filePath = join(dir, 'data.json');
    await writeFile(filePath, JSON.stringify({ a: 1 }));
    await expect(readJsonFile(filePath)).resolves.toEqual({ a: 1 });
  });

  it('wraps a missing file in VersionError', async () => {
    await expect(readJsonFile(join(dir, 'missing.json'))).rejects.toThrow(VersionError);
  });

  it('wraps invalid JSON in VersionError', async () => {
    const filePath = join(dir, 'bad.json');
    await writeFile(filePath, 'not json');
    await expect(readJsonFile(filePath)).rejects.toThrow(/not valid JSON/);
  });

  it('wraps a non-Error rejection from the filesystem too', async () => {
    vi.mocked(readFile).mockRejectedValueOnce('disk unavailable');
    await expect(readJsonFile(join(dir, 'whatever.json'))).rejects.toThrow(/disk unavailable/);
  });
});
