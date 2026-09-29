/** Input to {@link buildPythonPackage} for a single contract. */
export interface BuildPythonPackageInput {
  /** The canonical, key-sorted JSON bundle produced by `bundleSpec` (info.version already set to `version`). */
  bundledSpec: string;
  /** PEP 503 normalised distribution name, e.g. `my-service-api`. */
  packageName: string;
  /** The version to stamp into `pyproject.toml`, `[tool.speckify]` and the bundled spec's `info.version`. */
  version: string;
  /** Whether to generate the `client` submodule (openapi-python-client). */
  client: boolean;
  /** Whether to generate the `server` submodule (Handlers protocol + FastAPI router). */
  server: boolean;
  /** Rendered into `CHANGELOG.md` verbatim; the caller owns its formatting. */
  changelog: string;
  /** Recorded in `[tool.speckify] speckify_version` for support/debugging. */
  speckifyVersion: string;
}

/** Where {@link buildPythonPackage} was asked to do its work. */
export interface BuildPythonPackageOptions {
  /** An empty or non-existent directory the generated project is written into. */
  projectDir: string;
  /** The `python/` toolchain directory (containing `pyproject.toml` + `uv.lock`) whose pinned tools are run. */
  toolchainDir: string;
}

/** A built distribution artifact. */
export interface BuiltArtifact {
  /** Absolute path to the file `uv build` produced. */
  path: string;
  /** `wheel` or `sdist`. */
  kind: 'wheel' | 'sdist';
}

/** The result of a full generate-then-build run. */
export interface BuildPythonPackageResult {
  /** The import name derived from `packageName` (hyphens become underscores). */
  importName: string;
  /** Absolute path to the generated project directory (equal to `options.projectDir`). */
  projectDir: string;
  /** The wheel and sdist `uv build` produced. */
  artifacts: readonly BuiltArtifact[];
}

/** How a single OpenAPI parameter or header is represented. */
export interface ParamInfo {
  name: string;
  /** The Python identifier the template binds it to (snake_case). */
  pyName: string;
  required: boolean;
  /** A Python type expression, kept deliberately simple (str/int/float/bool). */
  pyType: string;
}

export type RequestBodyInfo =
  | { kind: 'json'; required: boolean; model: string }
  | { kind: 'octet-stream'; required: boolean }
  | { kind: 'none' };

export interface ResponseInfo {
  statusCode: string;
  /** A pydantic model class name, or `null` when the response has no typed body. */
  model: string | null;
}

/** The operation shape both the completeness guard and the server generator consume. */
export interface OperationInfo {
  operationId: string;
  method: string;
  path: string;
  pathParams: readonly ParamInfo[];
  queryParams: readonly ParamInfo[];
  headerParams: readonly ParamInfo[];
  requestBody: RequestBodyInfo;
  responses: readonly ResponseInfo[];
}
