/** Raised when `speckify.yaml` cannot be read, parsed or validated. */
export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
