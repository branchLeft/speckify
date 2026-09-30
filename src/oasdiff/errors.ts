/** Raised when the oasdiff binary cannot be resolved, downloaded or run. */
export class OasdiffError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OasdiffError';
  }
}
