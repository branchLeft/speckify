import { describe, expect, it } from 'vitest';

import { reconcileVersions } from './reconcile.js';

describe('reconcileVersions', () => {
  it('reports every target missing when none has ever published', () => {
    const result = reconcileVersions([
      { target: 'typescript-client', entry: null },
      { target: 'python-client', entry: null },
    ]);

    expect(result).toEqual({
      maxVersion: null,
      missingTargets: ['typescript-client', 'python-client'],
    });
  });

  it('takes the max version across targets and reports the ones lagging behind', () => {
    const result = reconcileVersions([
      {
        target: 'typescript-client',
        entry: { version: '1.2.0', bundledSpec: '{}', speckifyVersion: null },
      },
      {
        target: 'python-client',
        entry: { version: '1.3.0', bundledSpec: '{}', speckifyVersion: null },
      },
      { target: 'python-server', entry: null },
    ]);

    expect(result.maxVersion).toBe('1.3.0');
    expect(result.missingTargets.sort()).toEqual(['python-server', 'typescript-client']);
  });

  it('reports no missing targets when every target is at the max version', () => {
    const result = reconcileVersions([
      {
        target: 'typescript-client',
        entry: { version: '1.3.0', bundledSpec: '{}', speckifyVersion: null },
      },
      {
        target: 'python-client',
        entry: { version: '1.3.0', bundledSpec: '{}', speckifyVersion: null },
      },
    ]);

    expect(result).toEqual({ maxVersion: '1.3.0', missingTargets: [] });
  });

  it('ignores an entry whose version is not valid semver when computing the max', () => {
    const result = reconcileVersions([
      {
        target: 'typescript-client',
        entry: { version: 'not-a-version', bundledSpec: '{}', speckifyVersion: null },
      },
      {
        target: 'python-client',
        entry: { version: '1.0.0', bundledSpec: '{}', speckifyVersion: null },
      },
    ]);

    expect(result.maxVersion).toBe('1.0.0');
  });

  it('returns no missing targets for an empty record set', () => {
    expect(reconcileVersions([])).toEqual({ maxVersion: null, missingTargets: [] });
  });
});
