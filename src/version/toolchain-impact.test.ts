import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VersionError } from './errors.js';
import { loadClassificationMap, loadToolchainImpact, toolchainImpact } from './toolchain-impact.js';
import type { ToolchainImpactEntry } from './types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

const entries: ToolchainImpactEntry[] = [
  { speckifyVersion: '0.1.0', impact: 'none' },
  { speckifyVersion: '0.2.0', impact: 'patch' },
  { speckifyVersion: '0.3.0', impact: 'major' },
];

describe('toolchainImpact', () => {
  it('returns none when there is no previous speckify version', () => {
    expect(toolchainImpact(entries, null, '0.3.0')).toBe('none');
  });

  it('takes the max impact of releases strictly after the previous version', () => {
    expect(toolchainImpact(entries, '0.1.0', '0.3.0')).toBe('major');
  });

  it('excludes releases at or before the previous version', () => {
    expect(toolchainImpact(entries, '0.2.0', '0.3.0')).toBe('major');
    expect(toolchainImpact(entries, '0.3.0', '0.3.0')).toBe('none');
  });

  it('excludes releases after the current version', () => {
    expect(toolchainImpact(entries, '0.1.0', '0.2.0')).toBe('patch');
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

describe('loadClassificationMap', () => {
  it('loads and validates the committed fixture', async () => {
    const result = await loadClassificationMap(`${fixturesDir}classification-map.json`);
    expect(result).toEqual({
      'response-required-property-removed': 'major',
      'request-property-added': 'minor',
      'description-changed': 'patch',
    });
  });

  it('throws VersionError for invalid JSON', async () => {
    await expect(loadClassificationMap(`${fixturesDir}invalid.json`)).rejects.toThrow(VersionError);
  });

  it('throws VersionError for a map with an invalid bump value', async () => {
    await expect(loadClassificationMap(`${fixturesDir}invalid-map.json`)).rejects.toThrow(
      VersionError,
    );
  });
});
