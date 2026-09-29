import { describe, expect, it } from 'vitest';

import { SPECKIFY_REPO } from './constants.js';
import { renderCallerWorkflow } from './init/workflow-template.js';

const FORTY_HEX = 'a'.repeat(40);

describe('SPECKIFY_REPO', () => {
  it('points at branchLeft/speckify, never the unrelated speckify org', () => {
    expect(SPECKIFY_REPO).toBe('branchLeft/speckify');
  });

  it('is the repo init stamps into the generated caller workflow, pinned to a 40-hex sha', () => {
    const yamlText = renderCallerWorkflow({
      repo: SPECKIFY_REPO,
      ref: FORTY_HEX,
      tag: 'v1.2.0',
      configPath: 'speckify.yaml',
    });
    // The generated workflow calls the composite action directly, not
    // Speckify's reusable workflow (which PyPI's trusted publishing can't
    // be configured against) -- see workflow-template.test.ts.
    expect(yamlText).toContain(`uses: branchLeft/speckify@${FORTY_HEX} # v1.2.0`);
  });
});
