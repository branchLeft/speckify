import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { resolveOasdiffBinary } from '../oasdiff/binary.js';
import {
  OASDIFF_CHECKS_FILENAME,
  OASDIFF_CLASSIFICATION_MAP_FILENAME,
} from '../oasdiff/version.js';
import { loadClassificationMap, loadOasdiffCheckIds } from './classification-map.js';

const execFileAsync = promisify(execFile);

// These two files are the real, committed data Speckify ships and loads at
// runtime (see cli.ts's buildPlanContext) — not fixtures, so this test lives
// against the repo root rather than src/version/fixtures.
const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const classificationMapPath = join(dataDir, OASDIFF_CLASSIFICATION_MAP_FILENAME);
const checksPath = join(dataDir, OASDIFF_CHECKS_FILENAME);

describe('the committed classification map is complete', () => {
  it('classifies exactly the rule ids the committed oasdiff rule catalogue declares', async () => {
    const map = await loadClassificationMap(classificationMapPath);
    const catalogueIds = await loadOasdiffCheckIds(checksPath);
    const mapIds = new Set(Object.keys(map));

    const missingFromMap = [...catalogueIds].filter((id) => !mapIds.has(id));
    const extraInMap = [...mapIds].filter((id) => !catalogueIds.has(id));

    expect(missingFromMap).toEqual([]);
    expect(extraInMap).toEqual([]);
  });

  it('the committed rule catalogue matches what the real oasdiff binary reports today', async () => {
    let oasdiffPath: string;
    try {
      oasdiffPath = await resolveOasdiffBinary({
        cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff'),
      });
    } catch {
      // No cached or downloadable binary in this environment — the
      // completeness check above (map vs. committed catalogue) still runs;
      // only the catalogue-vs.-live-binary cross-check is skipped.
      return;
    }

    const { stdout } = await execFileAsync(
      oasdiffPath,
      ['checks', 'changelog', '--format', 'json'],
      {
        maxBuffer: 1024 * 1024 * 64,
      },
    );
    const live = JSON.parse(stdout) as { id: string }[];
    const liveIds = new Set(live.map((check) => check.id));
    const catalogueIds = await loadOasdiffCheckIds(checksPath);

    expect([...liveIds].sort()).toEqual([...catalogueIds].sort());
  });
});
