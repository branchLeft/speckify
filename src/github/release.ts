import type { GithubClient } from './client.js';

export interface ReleaseAsset {
  name: string;
  contentType: string;
  data: Buffer;
}

export interface CreateReleaseOptions {
  owner: string;
  repo: string;
  /** e.g. `orders-api@v1.1.0` — created against the repo's default branch. */
  tagName: string;
  name: string;
  body: string;
  assets: readonly ReleaseAsset[];
}

export interface CreateReleaseResult {
  ok: boolean;
  /** Set when `ok` is false: what went wrong, for a log line — never thrown. */
  warning?: string;
}

interface CreatedRelease {
  id: number;
  upload_url: string;
}

function isCreatedRelease(value: unknown): value is CreatedRelease {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'number' &&
    typeof (value as { upload_url?: unknown }).upload_url === 'string'
  );
}

/**
 * Creates a tag and GitHub Release in one call (`tag_name` on a release that
 * doesn't exist yet creates the tag against the repo's default branch), then
 * uploads each asset.
 *
 * The registry is the record, not this release — so a failure here, at any
 * step, is reported as a warning rather than thrown. Callers should log
 * `warning` and carry on; nothing about a successful publish depends on this
 * succeeding.
 */
export async function createGithubRelease(
  client: GithubClient,
  options: CreateReleaseOptions,
): Promise<CreateReleaseResult> {
  let created: CreatedRelease;
  try {
    const response = await client.request(`/repos/${options.owner}/${options.repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: options.tagName, name: options.name, body: options.body }),
    });
    if (!response.ok) {
      return {
        ok: false,
        warning: `could not create release "${options.tagName}": ${String(response.status)}`,
      };
    }
    const parsed: unknown = await response.json();
    if (!isCreatedRelease(parsed)) {
      return {
        ok: false,
        warning: `GitHub returned a malformed release response for "${options.tagName}"`,
      };
    }
    created = parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, warning: `could not create release "${options.tagName}": ${reason}` };
  }

  // `upload_url` is a URI template (`.../assets{?name,label}`) on a
  // different host than the API itself.
  const uploadBase = created.upload_url.replace(/\{.*\}$/, '');

  for (const asset of options.assets) {
    try {
      const url = `${uploadBase}?name=${encodeURIComponent(asset.name)}`;
      const response = await client.requestAbsolute(url, {
        method: 'POST',
        headers: { 'Content-Type': asset.contentType },
        body: asset.data,
      });
      if (!response.ok) {
        return {
          ok: false,
          warning: `release "${options.tagName}" created, but uploading asset "${asset.name}" failed: ${String(response.status)}`,
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        warning: `release "${options.tagName}" created, but uploading asset "${asset.name}" failed: ${reason}`,
      };
    }
  }

  return { ok: true };
}
