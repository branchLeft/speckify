import type { OasdiffChange } from '../oasdiff/types.js';
import { maxBump } from './bump.js';
import type { ClassificationMap, ClassifyResult } from './types.js';

/**
 * Classifies a set of oasdiff changes into a single bump, using `map` to
 * translate each change's rule id. A rule id the map has no entry for is
 * never ignored: it counts as `major` and is reported in `unknownRuleIds`,
 * so an incomplete map produces a loud over-bump rather than a silent
 * under-bump.
 */
export function classify(
  changes: readonly OasdiffChange[],
  map: ClassificationMap,
): ClassifyResult {
  const unknownRuleIds = new Set<string>();
  const bumps = changes.map((change) => {
    const bump = map[change.id];
    if (bump === undefined) {
      unknownRuleIds.add(change.id);
      return 'major' as const;
    }
    return bump;
  });

  return { bump: maxBump(bumps), unknownRuleIds: [...unknownRuleIds] };
}
