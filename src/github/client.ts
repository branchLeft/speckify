import type { FetchLike } from '../record/index.js';

export interface GithubClientOptions {
  token: string;
  apiUrl?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

export interface GithubClient {
  apiUrl: string;
  /** `path` is resolved against `apiUrl`, e.g. `/repos/acme/orders-api/releases`. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Same auth and headers as `request`, but against an absolute URL —
   * needed for the asset-upload endpoint, which GitHub serves from a
   * different host (`uploads.github.com`) than the API itself.
   */
  requestAbsolute(url: string, init?: RequestInit): Promise<Response>;
}

/** A thin wrapper over `fetch` that carries the base URL and auth header every call needs. */
export function createGithubClient(options: GithubClientOptions): GithubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');

  async function requestAbsolute(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${options.token}`);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    return fetchImpl(url, { ...init, headers });
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return requestAbsolute(`${apiUrl}${path}`, init);
  }

  return { apiUrl, request, requestAbsolute };
}
