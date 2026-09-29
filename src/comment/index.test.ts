import { describe, expect, it } from 'vitest';

import * as comment from './index.js';

describe('comment barrel', () => {
  it('re-exports the public API', () => {
    expect(typeof comment.renderPrComment).toBe('function');
    expect(typeof comment.PR_COMMENT_MARKER).toBe('string');
  });
});
