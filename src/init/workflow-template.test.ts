import { describe, expect, it } from 'vitest';

import { renderCallerWorkflow } from './workflow-template.js';

describe('renderCallerWorkflow', () => {
  it('pins the reusable workflow to the given ref with the tag as a trailing comment', () => {
    const yamlText = renderCallerWorkflow({
      repo: 'branchLeft/speckify',
      ref: 'a'.repeat(40),
      tag: 'v1.2.0',
      configPath: 'speckify.yaml',
    });
    expect(yamlText).toContain(
      `uses: branchLeft/speckify/.github/workflows/speckify.yml@${'a'.repeat(40)} # v1.2.0`,
    );
    expect(yamlText).toContain('config: speckify.yaml');
    expect(yamlText).toContain(`ref: ${'a'.repeat(40)}`);
    expect(yamlText).toContain('on:');
    expect(yamlText).toContain('pull_request:');
    expect(yamlText).toContain('branches: [main]');
  });
});
