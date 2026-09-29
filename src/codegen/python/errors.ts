/** Base class for every error this module raises; lets callers catch one type. */
export class PythonCodegenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PythonCodegenError';
  }
}

/** Raised when `uv` cannot be found on `PATH`. */
export class UvNotFoundError extends PythonCodegenError {
  public constructor() {
    super(
      'uv is required to run the pinned Python generators but was not found on PATH. Install it from https://docs.astral.sh/uv/ and try again.',
    );
    this.name = 'UvNotFoundError';
  }
}

/** Raised when a pinned Python subprocess (uv-run tool) exits non-zero. */
export class SubprocessError extends PythonCodegenError {
  public constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(
      `"${command}" failed${exitCode === null ? '' : ` with exit code ${String(exitCode)}`}: ${stderr.trim()}`,
    );
    this.name = 'SubprocessError';
  }
}

/** Raised when datamodel-code-generator fails to produce a models module. */
export class ModelGenerationError extends PythonCodegenError {
  public constructor(message: string) {
    super(message);
    this.name = 'ModelGenerationError';
  }
}

/** Raised when openapi-python-client fails outright (not the completeness-guard case). */
export class ClientGenerationError extends PythonCodegenError {
  public constructor(message: string) {
    super(message);
    this.name = 'ClientGenerationError';
  }
}

/**
 * Raised when the generated client is missing a function for one or more
 * operationIds in the spec. This is the guard against openapi-python-client
 * silently skipping an endpoint it cannot generate (e.g. a `format: date-time`
 * header parameter) rather than a normal generator failure.
 */
export class CompletenessGuardError extends PythonCodegenError {
  public constructor(public readonly missingOperationIds: readonly string[]) {
    super(
      `the generated Python client is missing ${String(missingOperationIds.length)} operation(s): ${missingOperationIds.join(', ')}. ` +
        'openapi-python-client 0.29.1 silently skips endpoints it cannot generate — most commonly a header parameter with `format: date-time` ' +
        '(https://github.com/openapi-generators/openapi-python-client/issues) — so this is refused rather than shipped with a partial client.',
    );
    this.name = 'CompletenessGuardError';
  }
}

/** Raised when `uv build` fails to produce a wheel and sdist. */
export class BuildError extends PythonCodegenError {
  public constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}
