/** Raised when publishing a generated package to its registry fails. */
export class PublishError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}
