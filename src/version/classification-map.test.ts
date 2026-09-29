import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadClassificationMap, loadOasdiffCheckIds } from './classification-map.js';
import { VersionError } from './errors.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('loadClassificationMap', () => {
  it('loads the committed fixture into an id -> bump lookup', async () => {
    const result = await loadClassificationMap(`${fixturesDir}classification-map.json`, {
      expectedOasdiffVersion: '1.32.1',
    });
    expect(result).toEqual({
      'response-required-property-removed': 'major',
      'request-property-added': 'minor',
      'description-changed': 'patch',
    });
  });

  it('defaults expectedOasdiffVersion to the constant every other part of Speckify pins to', async () => {
    // The fixture is pinned to 1.32.1, which is also OASDIFF_VERSION today;
    // this proves the default is wired up, not just the override.
    await expect(
      loadClassificationMap(`${fixturesDir}classification-map.json`),
    ).resolves.toBeDefined();
  });

  it('throws VersionError for invalid JSON', async () => {
    await expect(loadClassificationMap(`${fixturesDir}invalid.json`)).rejects.toThrow(VersionError);
  });

  it('throws VersionError for a map with an invalid bump value', async () => {
    await expect(
      loadClassificationMap(`${fixturesDir}invalid-map.json`, { expectedOasdiffVersion: '1.32.1' }),
    ).rejects.toThrow(VersionError);
  });

  it('throws VersionError for a duplicate rule id', async () => {
    await expect(
      loadClassificationMap(`${fixturesDir}classification-map-duplicate.json`, {
        expectedOasdiffVersion: '1.32.1',
      }),
    ).rejects.toThrow(/declares rule id "response-required-property-removed" more than once/);
  });

  it('throws VersionError when the file is pinned to a different oasdiff version', async () => {
    await expect(
      loadClassificationMap(`${fixturesDir}classification-map-wrong-version.json`, {
        expectedOasdiffVersion: '1.32.1',
      }),
    ).rejects.toThrow(/pinned to oasdiff 1\.0\.0, but Speckify is pinned to 1\.32\.1/);
  });
});

describe('loadOasdiffCheckIds', () => {
  it('loads the committed fixture into a set of ids', async () => {
    const result = await loadOasdiffCheckIds(`${fixturesDir}oasdiff-checks.json`);
    expect(result).toEqual(
      new Set([
        'response-required-property-removed',
        'request-property-added',
        'description-changed',
      ]),
    );
  });

  it('throws VersionError for invalid JSON', async () => {
    await expect(loadOasdiffCheckIds(`${fixturesDir}invalid.json`)).rejects.toThrow(VersionError);
  });
});
