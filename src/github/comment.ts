import { GithubError } from './errors.js';
import type { GithubClient } from './client.js';

export interface PrCommentTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

interface IssueComment {
  id: number;
  body?: string;
}

function isIssueCommentArray(value: unknown): value is IssueComment[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'object' && item !== null);
}

/**
 * Creates a comment on the PR, or updates Speckify's own previous one if it
 * finds one (identified by `marker`, a hidden HTML comment at the top of the
 * body) — so re-running `speckify check` on a new push edits the existing
 * comment rather than piling up a new one each time.
 *
 * @throws {GithubError} if the GitHub API call fails.
 */
export async function createOrUpdateComment(
  client: GithubClient,
  target: PrCommentTarget,
  marker: string,
  body: string,
): Promise<void> {
  const listPath = `/repos/${target.owner}/${target.repo}/issues/${String(target.prNumber)}/comments?per_page=100`;
  const listResponse = await client.request(listPath);
  if (!listResponse.ok) {
    throw new GithubError(
      `could not list comments on ${target.owner}/${target.repo}#${String(target.prNumber)}: ${String(listResponse.status)}`,
    );
  }

  const comments: unknown = await listResponse.json();
  if (!isIssueCommentArray(comments)) {
    throw new GithubError(
      `GitHub returned a malformed comment list for ${target.owner}/${target.repo}#${String(target.prNumber)}`,
    );
  }

  const existing = comments.find((comment) => comment.body?.startsWith(marker) === true);

  const path = existing
    ? `/repos/${target.owner}/${target.repo}/issues/comments/${String(existing.id)}`
    : `/repos/${target.owner}/${target.repo}/issues/${String(target.prNumber)}/comments`;
  const method = existing ? 'PATCH' : 'POST';

  const response = await client.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new GithubError(
      `could not ${existing ? 'update' : 'create'} the PR comment on ${target.owner}/${target.repo}#${String(target.prNumber)}: ${String(response.status)}`,
    );
  }
}
