import { describe, expect, it, vi } from 'vitest';

import { createGithubClient } from './client.js';
import { createGithubRelease } from './release.js';

const options = {
  owner: 'acme',
  repo: 'orders-api',
  tagName: 'orders-api@v1.1.0',
  name: 'orders-api@v1.1.0',
  body: 'changelog',
  assets: [{ name: 'openapi.json', contentType: 'application/json', data: Buffer.from('{}') }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createGithubRelease', () => {
  it('creates the release and uploads every asset', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: 1,
            upload_url:
              'https://uploads.github.com/repos/acme/orders-api/releases/1/assets{?name,label}',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 99 }, 201));
    const client = createGithubClient({ token: 't', fetchImpl });

    const result = await createGithubRelease(client, options);

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://uploads.github.com/repos/acme/orders-api/releases/1/assets?name=openapi.json',
    );
  });

  it('returns a warning, never throws, when release creation fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 422 }));
    const client = createGithubClient({ token: 't', fetchImpl });

    const result = await createGithubRelease(client, options);

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/422/);
  });

  it('returns a warning when release creation throws (network failure)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const client = createGithubClient({ token: 't', fetchImpl });

    const result = await createGithubRelease(client, options);

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/ECONNRESET/);
  });

  it('returns a warning when the release response is malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ nope: true }, 201));
    const client = createGithubClient({ token: 't', fetchImpl });

    const result = await createGithubRelease(client, options);

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/malformed/);
  });

  it('returns a warning when an asset upload fails after the release was created', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: 1,
            upload_url:
              'https://uploads.github.com/repos/acme/orders-api/releases/1/assets{?name,label}',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const client = createGithubClient({ token: 't', fetchImpl });

    const result = await createGithubRelease(client, options);

    expect(result.ok).toBe(false);
    expect(result.warning).toContain('openapi.json');
  });

  it('returns a warning when an asset upload throws', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: 1,
            upload_url:
              'https://uploads.github.com/repos/acme/orders-api/releases/1/assets{?name,label}',
          },
          201,
        ),
      )
      .mockRejectedValueOnce(new Error('boom'));
    const client = createGithubClient({ token: 't', fetchImpl });

    const result = await createGithubRelease(client, options);

    expect(result.ok).toBe(false);
    expect(result.warning).toContain('boom');
  });
});
