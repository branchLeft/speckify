import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repositoryDirectoryFor } from './repository-directory.js';

const root = path.resolve('/work/repo');

describe('repositoryDirectoryFor', () => {
  it("is the spec's directory relative to the repository root, with forward slashes", () => {
    expect(
      repositoryDirectoryFor(root, path.join(root, 'services', 'broker', 'openapi.yaml')),
    ).toBe('services/broker');
  });

  it('is one segment for a spec directly under a top-level directory', () => {
    expect(repositoryDirectoryFor(root, path.join(root, 'api', 'openapi.yaml'))).toBe('api');
  });

  it('is undefined for a spec at the repository root, where there is no directory to name', () => {
    expect(repositoryDirectoryFor(root, path.join(root, 'openapi.yaml'))).toBeUndefined();
  });

  it('is undefined for a spec outside the repository', () => {
    expect(repositoryDirectoryFor(root, path.resolve('/work/other/openapi.yaml'))).toBeUndefined();
    expect(repositoryDirectoryFor(root, path.resolve('/work/repo-sibling/x.yaml'))).toBeUndefined();
  });

  it('keeps a directory whose own name merely starts with two dots', () => {
    expect(repositoryDirectoryFor(root, path.join(root, '..api', 'openapi.yaml'))).toBe('..api');
  });

  it('is undefined when the derived path is not one the manifest may carry', () => {
    expect(repositoryDirectoryFor(root, path.join(root, 'a\\b', 'openapi.yaml'))).toBeUndefined();
  });
});
