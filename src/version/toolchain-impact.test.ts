import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VersionError } from './errors.js';
import {
  loadToolchainImpact,
  toolchainImpact,
  TOOLCHAIN_IMPACT_FILENAME,
} from './toolchain-impact.js';
import type { ToolchainImpactEntry } from './types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));

const entries: ToolchainImpactEntry[] = [
  { speckifyVersion: '0.1.0', impact: 'none' },
  { speckifyVersion: '0.2.0', impact: 'patch' },
  { speckifyVersion: '0.3.0', impact: 'major' },
];

describe('toolchainImpact', () => {
  it('returns none when the contract has never been published before (no previous state at all)', () => {
    expect(toolchainImpact(entries, null, '0.3.0')).toBe('none');
  });

  it('takes the max impact of releases strictly after the previous version', () => {
    expect(toolchainImpact(entries, { speckifyVersion: '0.1.0' }, '0.3.0')).toBe('major');
  });

  it('excludes releases at or before the previous version', () => {
    expect(toolchainImpact(entries, { speckifyVersion: '0.2.0' }, '0.3.0')).toBe('major');
    expect(toolchainImpact(entries, { speckifyVersion: '0.3.0' }, '0.3.0')).toBe('none');
  });

  it('excludes releases after the current version', () => {
    expect(toolchainImpact(entries, { speckifyVersion: '0.1.0' }, '0.2.0')).toBe('patch');
  });

  // A published package that predates the embedded speckifyVersion field
  // (or, for a wheel/tarball, is missing it for any other reason) has an
  // *unknown* generating version -- not "never generated before". Reading
  // that as "no prior state" (impact: none) would silently under-bump every
  // consumer of an old, un-tracked package the moment a toolchain fix
  // ships. Fail safe: treat it as though it predates every recorded release.
  it('fail-safes to the max impact of every recorded release when the previous speckifyVersion is unknown', () => {
    expect(toolchainImpact(entries, { speckifyVersion: null }, '0.3.0')).toBe('major');
  });

  it('an unknown previous speckifyVersion still respects the current-version ceiling', () => {
    const entriesWithHigherLater: ToolchainImpactEntry[] = [
      { speckifyVersion: '0.1.0', impact: 'patch' },
      { speckifyVersion: '0.9.0', impact: 'major' },
    ];
    expect(toolchainImpact(entriesWithHigherLater, { speckifyVersion: null }, '0.1.0')).toBe(
      'patch',
    );
  });
});

describe('loadToolchainImpact', () => {
  it('loads and validates the committed fixture', async () => {
    const result = await loadToolchainImpact(`${fixturesDir}toolchain-impact.json`);
    expect(result).toEqual(entries);
  });

  it('throws VersionError for a missing file', async () => {
    await expect(loadToolchainImpact(`${fixturesDir}missing.json`)).rejects.toThrow(VersionError);
  });

  it('throws VersionError for a file that fails schema validation', async () => {
    await expect(loadToolchainImpact(`${fixturesDir}classification-map.json`)).rejects.toThrow(
      VersionError,
    );
  });
});

describe('the committed data/toolchain-impact.json', () => {
  it('ships in data/, resolved like the classification map (package root, not the consumer config dir)', async () => {
    const result = await loadToolchainImpact(join(dataDir, TOOLCHAIN_IMPACT_FILENAME));
    expect(result).toEqual([{ speckifyVersion: '0.1.0', impact: 'none' }]);
  });
});
