import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deriveLocationClaims } from '../../scripts/generate-oasdiff-location-claims.mjs';
import {
  OASDIFF_CHECKS_FILENAME,
  OASDIFF_LOCATION_CLAIMS_FILENAME,
  OASDIFF_SILENT_CLAIMS_FILENAME,
  OASDIFF_VERSION,
} from '../oasdiff/version.js';
import { readJsonFile } from './json-file.js';
import { locationClaimsFileSchema, silentClaimsFileSchema } from './types.js';

// The real, committed data Speckify ships and loads at runtime, not fixtures.
const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));

async function committedClaims(): Promise<{ oasdiffVersion: string; claims: unknown[] }> {
  return locationClaimsFileSchema.parse(
    await readJsonFile(join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME)),
  );
}

describe(`the committed oasdiff ${OASDIFF_VERSION} location claims`, () => {
  it('are exactly what re-deriving from the committed rule catalogue produces', async () => {
    const checks = (await readJsonFile(join(dataDir, OASDIFF_CHECKS_FILENAME))) as {
      locations?: string[];
    }[];
    const committed = await committedClaims();
    expect(committed.oasdiffVersion).toBe(OASDIFF_VERSION);
    expect(committed.claims).toEqual(deriveLocationClaims(checks));
  });

  it('include every location of every rule, so none is dropped', async () => {
    const checks = (await readJsonFile(join(dataDir, OASDIFF_CHECKS_FILENAME))) as {
      locations?: string[];
    }[];
    const derived = deriveLocationClaims(checks);
    for (const check of checks) {
      for (const location of check.locations ?? []) {
        const [pattern, actions = ''] = location.split(':');
        const claim = derived.find((entry) => entry.pattern === pattern);
        expect(claim, location).toBeDefined();
        for (const action of actions.split(',')) {
          expect(claim?.actions, location).toContain(action);
        }
      }
    }
  });

  it('reject a malformed claim rather than skip it', () => {
    expect(() => deriveLocationClaims([{ locations: ['paths.*'] }])).toThrow(/malformed/);
  });
});

describe(`the committed oasdiff ${OASDIFF_VERSION} silent claims`, () => {
  it('only ever narrow a real claim: same pattern, a subset of its actions', async () => {
    const claims = (await committedClaims()).claims as { pattern: string; actions: string[] }[];
    const silent = silentClaimsFileSchema.parse(
      await readJsonFile(join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME)),
    );
    expect(silent.oasdiffVersion).toBe(OASDIFF_VERSION);
    for (const entry of silent.entries) {
      const claim = claims.find((candidate) => candidate.pattern === entry.pattern);
      expect(claim, entry.pattern).toBeDefined();
      for (const action of entry.actions) {
        expect(claim?.actions, `${entry.pattern}:${action}`).toContain(action);
      }
    }
  });
});
