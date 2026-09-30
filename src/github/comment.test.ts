import { describe, expect, it, vi } from 'vitest';

import { createGithubClient } from './client.js';
import { GithubError } from './errors.js';
import { createOrUpdateComment } from './comment.js';

const target = { owner: 'acme', repo: 'orders-api', prNumber: 42 };
const marker = '<!-- speckify:pr-comment -->';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createOrUpdateComment', () => {
  it('creates a new comment when no existing marked comment is found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 1, body: 'unrelated comment' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }, 201));
    const client = createGithubClient({ token: 't', fetchImpl });

    await createOrUpdateComment(client, target, marker, `${marker}\nhello`);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('/issues/42/comments');
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).method).toBe('POST');
  });

  it('updates the existing marked comment instead of creating a new one', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 1, body: 'unrelated' },
          { id: 7, body: `${marker}\nold body` },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 7 }, 200));
    const client = createGithubClient({ token: 't', fetchImpl });

    await createOrUpdateComment(client, target, marker, `${marker}\nnew body`);

    expect(fetchImpl.mock.calls[1]?.[0]).toContain('/issues/comments/7');
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).method).toBe('PATCH');
  });

  it('throws GithubError when listing comments fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const client = createGithubClient({ token: 't', fetchImpl });
    await expect(createOrUpdateComment(client, target, marker, 'body')).rejects.toThrow(
      GithubError,
    );
  });

  it('throws GithubError when the comment list is malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ not: 'an array' }));
    const client = createGithubClient({ token: 't', fetchImpl });
    await expect(createOrUpdateComment(client, target, marker, 'body')).rejects.toThrow(
      GithubError,
    );
  });

  it('throws GithubError when creating the comment fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(new Response('', { status: 403 }));
    const client = createGithubClient({ token: 't', fetchImpl });
    await expect(createOrUpdateComment(client, target, marker, 'body')).rejects.toThrow(
      GithubError,
    );
  });
});
