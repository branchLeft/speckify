/** Base class for every error this module raises; never thrown directly. */
export abstract class CodegenError extends Error {}

/** The input (bundled spec, options) does not satisfy this module's contract. */
export class CodegenInputError extends CodegenError {}

/**
 * @hey-api/openapi-ts produced fewer operations than the spec declares, or
 * failed outright. Raised instead of silently shipping a partial package.
 */
export class IncompleteGenerationError extends CodegenError {
  constructor(
    message: string,
    readonly missingOperationIds: readonly string[],
  ) {
    super(message);
  }
}

/** The generated package failed to typecheck or compile. */
export class BuildError extends CodegenError {
  constructor(
    message: string,
    readonly diagnostics: readonly string[],
  ) {
    super(message);
  }
}
