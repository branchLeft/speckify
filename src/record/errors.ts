/** Raised when a package registry cannot be reached or its response is malformed. */
export class RecordError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}
