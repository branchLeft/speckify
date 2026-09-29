import { describe, expect, it, vi } from 'vitest';

import { createGithubClient } from './client.js';

describe('createGithubClient', () => {
  it('resolves a relative path against the default API URL with auth headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    const client = createGithubClient({ token: 'secret', fetchImpl });

    await client.request('/repos/acme/orders-api');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/orders-api',
      expect.objectContaining({ headers: expect.any(Headers) as unknown }),
    );
    const call = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer secret');
  });

  it('resolves a relative path against a configured API URL, trimming a trailing slash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    const client = createGithubClient({
      token: 'secret',
      apiUrl: 'https://ghe.example.com/api/v3/',
      fetchImpl,
    });

    await client.request('/repos/acme/orders-api');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ghe.example.com/api/v3/repos/acme/orders-api',
      expect.anything(),
    );
  });

  it('requestAbsolute sends auth headers to an arbitrary host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}'));
    const client = createGithubClient({ token: 'secret', fetchImpl });

    await client.requestAbsolute('https://uploads.github.com/anything');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://uploads.github.com/anything',
      expect.anything(),
    );
  });
});
