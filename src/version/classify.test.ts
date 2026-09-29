import { describe, expect, it } from 'vitest';

import type { OasdiffChange } from '../oasdiff/types.js';
import { classify } from './classify.js';
import type { ClassificationMap } from './types.js';

const map: ClassificationMap = {
  'response-required-property-removed': 'major',
  'request-property-added': 'minor',
  'description-changed': 'patch',
};

function change(id: string): OasdiffChange {
  return { id, text: `change for ${id}`, level: 3 };
}

describe('classify', () => {
  it('takes the highest bump across mapped changes', () => {
    const result = classify([change('description-changed'), change('request-property-added')], map);
    expect(result.bump).toBe('minor');
    expect(result.unknownRuleIds).toEqual([]);
  });

  it('treats a rule id absent from the map as major and reports it', () => {
    const result = classify([change('description-changed'), change('some-new-rule')], map);
    expect(result.bump).toBe('major');
    expect(result.unknownRuleIds).toEqual(['some-new-rule']);
  });

  it('deduplicates repeated unknown rule ids', () => {
    const result = classify([change('unknown-a'), change('unknown-a'), change('unknown-b')], map);
    expect(result.unknownRuleIds.sort()).toEqual(['unknown-a', 'unknown-b']);
  });

  it('returns none for an empty change list', () => {
    const result = classify([], map);
    expect(result).toEqual({ bump: 'none', unknownRuleIds: [] });
  });
});
