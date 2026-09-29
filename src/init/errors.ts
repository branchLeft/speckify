/** Raised when `speckify init` cannot detect a spec, or would overwrite existing files without `--force`. */
export class InitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}
