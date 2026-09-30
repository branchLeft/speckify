/** Raised when a GitHub REST call for the PR comment fails outright (network, auth, malformed response). */
export class GithubError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GithubError';
  }
}
