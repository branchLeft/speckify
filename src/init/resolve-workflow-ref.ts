import type { FetchLike } from '../record/index.js';

export interface ResolveWorkflowRefOptions {
  /** Speckify's own `<major>.<minor>.<patch>`, without the `v` prefix. */
  version: string;
  /** `owner/repo` hosting Speckify itself. */
  repo: string;
  fetchImpl?: FetchLike | undefined;
}

export interface ResolvedWorkflowRef {
  /** A 40-character commit SHA, or — on any resolution failure — the tag itself. */
  ref: string;
  /** Set when `ref` fell back to the tag; the CLI prints this. */
  warning?: string;
}

interface GitRef {
  object?: { sha?: string; type?: string };
}

function isGitRef(value: unknown): value is GitRef {
  return typeof value === 'object' && value !== null;
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${String(response.status)} for ${url}`);
  }
  return response.json();
}

/**
 * Resolves the release tag `v<version>` to the commit SHA it points at. An
 * annotated (signed) tag's ref object is the tag object itself, not the
 * commit, so that case needs a second lookup to dereference it.
 *
 * Never throws: any failure falls back to the tag itself, with `warning`
 * set for the caller to print.
 */
export async function resolveWorkflowRef(
  options: ResolveWorkflowRefOptions,
): Promise<ResolvedWorkflowRef> {
  const tag = `v${options.version}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const ref = await getJson(
      fetchImpl,
      `https://api.github.com/repos/${options.repo}/git/ref/tags/${tag}`,
    );
    if (!isGitRef(ref) || ref.object?.sha === undefined) {
      throw new Error(`malformed ref response for tag "${tag}"`);
    }

    if (ref.object.type === 'tag') {
      const tagObject = await getJson(
        fetchImpl,
        `https://api.github.com/repos/${options.repo}/git/tags/${ref.object.sha}`,
      );
      if (!isGitRef(tagObject) || tagObject.object?.sha === undefined) {
        throw new Error(`malformed tag object response for tag "${tag}"`);
      }
      return { ref: tagObject.object.sha };
    }

    return { ref: ref.object.sha };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ref: tag,
      warning: `could not resolve a commit SHA for "${tag}" (${reason}); pinning the generated workflow to the tag instead — replace it with a SHA once you can reach the GitHub API`,
    };
  }
}
