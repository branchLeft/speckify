import { describe, expect, it } from 'vitest';

import { applyBump, FIRST_PUBLISHED_VERSION, maxBump } from './bump.js';
import { VersionError } from './errors.js';

describe('maxBump', () => {
  it('returns none for an empty list', () => {
    expect(maxBump([])).toBe('none');
  });

  it('ranks major above minor above patch above none', () => {
    expect(maxBump(['patch', 'none'])).toBe('patch');
    expect(maxBump(['minor', 'patch'])).toBe('minor');
    expect(maxBump(['patch', 'major', 'minor'])).toBe('major');
  });

  it('returns the single bump given a list of one', () => {
    expect(maxBump(['minor'])).toBe('minor');
  });
});

describe('applyBump', () => {
  it('returns the first published version when there is no current version', () => {
    expect(applyBump('major', null)).toBe(FIRST_PUBLISHED_VERSION);
    expect(applyBump('none', null)).toBe(FIRST_PUBLISHED_VERSION);
  });

  it('increments major/minor/patch from a current version', () => {
    expect(applyBump('major', '1.2.3')).toBe('2.0.0');
    expect(applyBump('minor', '1.2.3')).toBe('1.3.0');
    expect(applyBump('patch', '1.2.3')).toBe('1.2.4');
  });

  it('leaves the version unchanged for a none bump', () => {
    expect(applyBump('none', '1.2.3')).toBe('1.2.3');
  });

  it('throws VersionError for an invalid current version', () => {
    expect(() => applyBump('patch', 'not-a-version')).toThrow(VersionError);
  });
});
