import { describe, expect, it } from 'vitest';

import * as github from './index.js';

describe('github barrel', () => {
  it('re-exports the public API', () => {
    expect(typeof github.createGithubClient).toBe('function');
    expect(typeof github.createOrUpdateComment).toBe('function');
    expect(typeof github.createGithubRelease).toBe('function');
    expect(github.GithubError).toBeDefined();
  });
});
