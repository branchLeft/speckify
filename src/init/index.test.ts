import { describe, expect, it } from 'vitest';

import * as init from './index.js';

describe('init barrel', () => {
  it('re-exports the public API', () => {
    expect(typeof init.runInit).toBe('function');
    expect(typeof init.detectOpenapiSpecs).toBe('function');
    expect(typeof init.renderSpeckifyConfigYaml).toBe('function');
    expect(typeof init.contractNameFromSpecFile).toBe('function');
    expect(typeof init.resolveWorkflowRef).toBe('function');
    expect(typeof init.renderCallerWorkflow).toBe('function');
    expect(init.InitError).toBeDefined();
  });
});
