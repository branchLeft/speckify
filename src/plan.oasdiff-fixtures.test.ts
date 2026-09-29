import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { toCanonicalJson } from './bundle/canonical-json.js';
import {
  OASDIFF_CHECKS_FILENAME,
  OASDIFF_CLASSIFICATION_MAP_FILENAME,
  OASDIFF_LOCATION_CLAIMS_FILENAME,
  OASDIFF_SILENT_CLAIMS_FILENAME,
} from './oasdiff/version.js';
import { resolveOasdiffBinary } from './oasdiff/binary.js';
import type { OasdiffChange, ProcessRunner } from './oasdiff/index.js';
import { computeContractPlan } from './plan.js';
import { loadClassificationMap } from './version/classification-map.js';
import { loadOasdiffCoverage, type OasdiffCoverage } from './version/location-coverage.js';
import type { ClassificationMap } from './version/types.js';
import type { Bump } from './version/types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/oasdiff-scenarios/', import.meta.url));
const dataDir = fileURLToPath(new URL('../data/', import.meta.url));

async function bundledSpecFor(name: string): Promise<string> {
  const raw = await readFile(`${fixturesDir}${name}.json`, 'utf8');
  return toCanonicalJson(JSON.parse(raw) as unknown);
}

/**
 * These run the real classify path end to end: two real bundled specs, the
 * real committed classification map, and — when a working binary can be
 * resolved — the real oasdiff 1.32.1 binary (not a stubbed ProcessRunner).
 * Each fixture pair reproduces one scenario from the phase-0 spike report,
 * confirmed against the real binary while writing this test (see the
 * commit message for the exact `oasdiff changelog` output each pair
 * produces).
 */
describe('the real classify path, against real fixture pairs', () => {
  let classificationMap: ClassificationMap;
  let coverage: OasdiffCoverage;
  let oasdiffPath: string | null;

  beforeAll(async () => {
    classificationMap = await loadClassificationMap(
      join(dataDir, OASDIFF_CLASSIFICATION_MAP_FILENAME),
    );
    coverage = await loadOasdiffCoverage(
      join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME),
      join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME),
    );
    try {
      oasdiffPath = await resolveOasdiffBinary({
        cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff'),
      });
    } catch {
      oasdiffPath = null;
    }
  });

  async function planFor(revisionFixture: string): Promise<{ bump: Bump; version: string }> {
    if (oasdiffPath === null) {
      // No cached or downloadable binary in this environment — nothing
      // further to prove without one; see the "oasdiff output fixtures"
      // describe block below for the offline-safe equivalent coverage.
      return { bump: 'none', version: 'skipped' };
    }
    const base = await bundledSpecFor('base');
    const revision = await bundledSpecFor(revisionFixture);
    const plan = await computeContractPlan({
      contract: 'widgets-api',
      bundledSpec: revision,
      previous: { version: '1.0.0', bundledSpec: base, speckifyVersion: null },
      classificationMap,
      coverage,
      toolchainImpactBump: 'none',
      oasdiffPath,
    });
    return { bump: plan.bump, version: plan.version };
  }

  it('bumps major for a removed required response property', async () => {
    if (oasdiffPath === null) return;
    const plan = await planFor('removed-required-response-property');
    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps major for response-optional-property-removed', async () => {
    if (oasdiffPath === null) return;
    const plan = await planFor('removed-optional-response-property');
    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps minor for a new optional request parameter', async () => {
    if (oasdiffPath === null) return;
    const plan = await planFor('new-optional-request-parameter');
    expect(plan.bump).toBe('minor');
    expect(plan.version).toBe('1.1.0');
  });

  it('bumps minor for a new endpoint', async () => {
    if (oasdiffPath === null) return;
    const plan = await planFor('new-endpoint');
    expect(plan.bump).toBe('minor');
    expect(plan.version).toBe('1.1.0');
  });

  it('bumps patch for a description-only change', async () => {
    if (oasdiffPath === null) return;
    const plan = await planFor('description-only-change');
    expect(plan.bump).toBe('patch');
    expect(plan.version).toBe('1.0.1');
  });

  it('does not publish for identical normalised specs', async () => {
    if (oasdiffPath === null) return;
    const plan = await planFor('identical');
    expect(plan.bump).toBe('none');
    expect(plan.version).toBe('1.0.0');
  });
});

function runProcessReturning(changes: OasdiffChange[]): ProcessRunner {
  return vi.fn(async () => Promise.resolve({ stdout: JSON.stringify(changes), stderr: '' }));
}

/**
 * The same six scenarios, offline-safe: the oasdiff *output* each pair
 * produces was captured against the real 1.32.1 binary (see the commit
 * message) and replayed through a stub ProcessRunner, so this coverage
 * exists whether or not this environment has the binary cached.
 */
describe('the real classify path, against captured real oasdiff output', () => {
  let classificationMap: ClassificationMap;
  let coverage: OasdiffCoverage;

  beforeAll(async () => {
    classificationMap = await loadClassificationMap(
      join(dataDir, OASDIFF_CLASSIFICATION_MAP_FILENAME),
    );
    coverage = await loadOasdiffCoverage(
      join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME),
      join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME),
    );
  });

  async function planWithChanges(
    revisionFixture: string,
    changes: OasdiffChange[],
  ): Promise<{ bump: Bump; version: string }> {
    const base = await bundledSpecFor('base');
    const revision = await bundledSpecFor(revisionFixture);
    const plan = await computeContractPlan({
      contract: 'widgets-api',
      bundledSpec: revision,
      previous: { version: '1.0.0', bundledSpec: base, speckifyVersion: null },
      classificationMap,
      coverage,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning(changes),
    });
    return { bump: plan.bump, version: plan.version };
  }

  it('bumps major for a removed required response property', async () => {
    const plan = await planWithChanges('removed-required-response-property', [
      {
        id: 'response-required-property-removed',
        text: 'removed the required property `name` from the response with the `200` status',
        level: 3,
        operation: 'GET',
        path: '/widgets',
      },
      {
        id: 'api-version-not-bumped',
        text: 'a breaking change was detected but the version is still `0.0.0`',
        level: 1,
      },
    ]);
    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps major for response-optional-property-removed', async () => {
    const plan = await planWithChanges('removed-optional-response-property', [
      {
        id: 'response-optional-property-removed',
        text: 'removed the optional property `notes` from the response with the `200` status',
        level: 1,
        operation: 'GET',
        path: '/widgets',
      },
    ]);
    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps minor for a new optional request parameter', async () => {
    const plan = await planWithChanges('new-optional-request-parameter', [
      {
        id: 'new-optional-request-parameter',
        text: 'added the new optional `query` request parameter `sort`',
        level: 1,
        operation: 'GET',
        path: '/widgets',
      },
    ]);
    expect(plan.bump).toBe('minor');
    expect(plan.version).toBe('1.1.0');
  });

  it('bumps minor for a new endpoint', async () => {
    const plan = await planWithChanges('new-endpoint', [
      { id: 'endpoint-added', text: 'endpoint added', level: 1, operation: 'GET', path: '/health' },
    ]);
    expect(plan.bump).toBe('minor');
    expect(plan.version).toBe('1.1.0');
  });

  it('bumps patch for a description-only change', async () => {
    const plan = await planWithChanges('description-only-change', []);
    expect(plan.bump).toBe('patch');
    expect(plan.version).toBe('1.0.1');
  });

  it('does not publish for identical normalised specs', async () => {
    const plan = await planWithChanges('identical', []);
    expect(plan.bump).toBe('none');
    expect(plan.version).toBe('1.0.0');
  });
});

describe('the committed data files reference a real oasdiff rule catalogue', () => {
  it(`ships ${OASDIFF_CHECKS_FILENAME} and ${OASDIFF_CLASSIFICATION_MAP_FILENAME} in data/`, async () => {
    const checks = await readFile(join(dataDir, OASDIFF_CHECKS_FILENAME), 'utf8');
    expect(JSON.parse(checks)).toBeInstanceOf(Array);
  });
});
