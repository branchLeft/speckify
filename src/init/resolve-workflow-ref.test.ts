import { describe, expect, it, vi } from 'vitest';

import { resolveWorkflowRef } from './resolve-workflow-ref.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('resolveWorkflowRef', () => {
  it('resolves a lightweight tag directly to its commit SHA', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ object: { sha: 'a'.repeat(40), type: 'commit' } }));
    const result = await resolveWorkflowRef({
      version: '1.2.0',
      repo: 'branchLeft/speckify',
      fetchImpl,
    });
    expect(result).toEqual({ ref: 'a'.repeat(40) });
  });

  it('dereferences an annotated (signed) tag to its commit SHA', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ object: { sha: 'tag-sha', type: 'tag' } }))
      .mockResolvedValueOnce(jsonResponse({ object: { sha: 'b'.repeat(40) } }));
    const result = await resolveWorkflowRef({
      version: '1.2.0',
      repo: 'branchLeft/speckify',
      fetchImpl,
    });
    expect(result).toEqual({ ref: 'b'.repeat(40) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the tag with a warning when the API call fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const result = await resolveWorkflowRef({
      version: '1.2.0',
      repo: 'branchLeft/speckify',
      fetchImpl,
    });
    expect(result.ref).toBe('v1.2.0');
    expect(result.warning).toBeDefined();
  });

  it('falls back to the tag with a warning when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await resolveWorkflowRef({
      version: '1.2.0',
      repo: 'branchLeft/speckify',
      fetchImpl,
    });
    expect(result.ref).toBe('v1.2.0');
    expect(result.warning).toContain('offline');
  });

  it('falls back to the tag with a warning on a malformed ref response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ nope: true }));
    const result = await resolveWorkflowRef({
      version: '1.2.0',
      repo: 'branchLeft/speckify',
      fetchImpl,
    });
    expect(result.ref).toBe('v1.2.0');
    expect(result.warning).toBeDefined();
  });

  it('falls back to the tag with a warning on a malformed dereferenced tag object', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ object: { sha: 'tag-sha', type: 'tag' } }))
      .mockResolvedValueOnce(jsonResponse({ nope: true }));
    const result = await resolveWorkflowRef({
      version: '1.2.0',
      repo: 'branchLeft/speckify',
      fetchImpl,
    });
    expect(result.ref).toBe('v1.2.0');
    expect(result.warning).toBeDefined();
  });
});
