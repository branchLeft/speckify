import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deriveCoveredKeywords } from '../../scripts/generate-oasdiff-covered-keywords.mjs';
import { OASDIFF_CHECKS_FILENAME, OASDIFF_COVERED_KEYWORDS_FILENAME } from '../oasdiff/version.js';
import { readJsonFile } from './json-file.js';
import { loadCoveredKeywords } from './covered-keywords.js';

// These are the real, committed data Speckify ships and loads at runtime
// (see cli.ts's buildPlanContext) -- not fixtures.
const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const checksPath = join(dataDir, OASDIFF_CHECKS_FILENAME);
const coveredKeywordsPath = join(dataDir, OASDIFF_COVERED_KEYWORDS_FILENAME);

describe('the committed covered-keywords file is complete', () => {
  it('is exactly what re-deriving from the committed rule catalogue produces today', async () => {
    const checks = (await readJsonFile(checksPath)) as { locations?: string[] }[];
    const derived = deriveCoveredKeywords(checks);
    const committed = [...(await loadCoveredKeywords(coveredKeywordsPath))].sort();

    expect(committed).toEqual(derived);
  });

  it('rejects a covered-keywords file pinned to a different oasdiff version', async () => {
    await expect(
      loadCoveredKeywords(coveredKeywordsPath, { expectedOasdiffVersion: '999.0.0' }),
    ).rejects.toThrow(/pinned to oasdiff/);
  });
});
