import { describe, expect, it } from 'vitest';

import * as publish from './index.js';

describe('publish barrel', () => {
  it('re-exports the public API', () => {
    expect(typeof publish.publishContract).toBe('function');
    expect(typeof publish.hasFailures).toBe('function');
    expect(typeof publish.publishNpm).toBe('function');
    expect(typeof publish.publishPypi).toBe('function');
    expect(publish.PublishError).toBeDefined();
  });
});
