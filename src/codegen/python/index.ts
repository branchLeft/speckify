import { generateClient } from './client.js';
import { generateModels } from './models.js';
import { generateServer } from './server.js';
import { prepareServerSpec } from './server-spec.js';
import { importNameFor } from './naming.js';
import { writeProjectFiles } from './package-layout.js';
import { runUvBuild } from './build.js';
import type { UvRunnerDeps } from './uv.js';
import type {
  BuildPythonPackageInput,
  BuildPythonPackageOptions,
  BuildPythonPackageResult,
} from './types.js';

export * from './types.js';
export * from './errors.js';
export { importNameFor } from './naming.js';

/**
 * Generates a buildable Python package for one contract — pydantic models,
 * optionally a client (openapi-python-client) and/or a server basis
 * (Handlers Protocol + FastAPI router) — and builds it into a wheel and
 * sdist with `uv build`.
 *
 * Each generator step runs the pinned toolchain at `options.toolchainDir`
 * via `uv run --frozen`, so the exact generator versions the spike verified
 * are what actually run, on any machine with `uv` on `PATH`.
 */
export async function buildPythonPackage(
  input: BuildPythonPackageInput,
  options: BuildPythonPackageOptions,
  uvDeps: UvRunnerDeps = {},
): Promise<BuildPythonPackageResult> {
  const importName = importNameFor(input.packageName);
  const packageDir = await writeProjectFiles(input, options.projectDir);
  // The server validates inline JSON bodies against hoisted models, so both
  // the models and the server are generated from the prepared spec.
  const modelSpec = input.server ? prepareServerSpec(input.bundledSpec) : input.bundledSpec;

  await generateModels(modelSpec, {
    toolchainDir: options.toolchainDir,
    targetDir: packageDir,
    uvDeps,
  });

  if (input.client) {
    await generateClient(input.bundledSpec, {
      toolchainDir: options.toolchainDir,
      targetDir: packageDir,
      uvDeps,
    });
  }

  if (input.server) {
    await generateServer(modelSpec, {
      toolchainDir: options.toolchainDir,
      targetDir: packageDir,
      uvDeps,
    });
  }

  const artifacts = await runUvBuild({
    projectDir: options.projectDir,
    ...(uvDeps.env ? { env: uvDeps.env } : {}),
    ...(uvDeps.spawnFn ? { spawnFn: uvDeps.spawnFn } : {}),
  });

  return { importName, projectDir: options.projectDir, artifacts };
}
