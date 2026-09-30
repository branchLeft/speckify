/** Raised when a spec (or a `$ref` it pulls in) cannot be bundled. */
export class BundleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/** Raised when a `$ref` resolves to a file outside the allowed root. */
export class PathTraversalError extends BundleError {
  public constructor(offendingPath: string, root: string) {
    super(`refusing to bundle "${offendingPath}": it resolves outside the repo root "${root}"`);
    this.name = 'PathTraversalError';
  }
}
