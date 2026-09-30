/** Raised when a version cannot be computed: an invalid semver, or a malformed map file. */
export class VersionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VersionError';
  }
}
