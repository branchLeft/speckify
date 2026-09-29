import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertClientCompleteness } from './completeness-guard.js';
import { ClientGenerationError } from './errors.js';
import { extractOperations } from './operations.js';
import { runUv, type UvRunnerDeps } from './uv.js';

/**
 * The custom template directory overriding openapi-python-client's own
 * `model.py.jinja` to make every generated attrs model keyword-only. See
 * `templates/openapi-python-client/model.py.jinja` for why.
 */
export const CUSTOM_TEMPLATE_PATH = fileURLToPath(
  new URL('./templates/openapi-python-client/', import.meta.url),
);

export interface GenerateClientOptions {
  /** The `python/` toolchain directory whose pinned openapi-python-client runs. */
  toolchainDir: string;
  /** Where the `client/` submodule is written: `<targetDir>/client/`. */
  targetDir: string;
  uvDeps?: UvRunnerDeps;
}

async function copyDir(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.name === '.ruff_cache') {
      continue;
    }
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
    } else {
      await writeFile(destinationPath, await readFile(sourcePath));
    }
  }
}

/**
 * Runs openapi-python-client against `bundledSpec` and writes the result as
 * `<targetDir>/client/`, importable as `<import_name>.client`. See
 * `client.md` for the config options that place it there with no extra
 * nesting, and the completeness guard this depends on.
 *
 * @throws {ClientGenerationError} if the tool produces no output at all.
 * @throws {CompletenessGuardError} if any operationId has no generated
 * function.
 */
export async function generateClient(
  bundledSpec: string,
  options: GenerateClientOptions,
): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'speckify-opc-'));
  try {
    const specPath = join(scratchDir, 'spec.json');
    await writeFile(specPath, bundledSpec, 'utf8');

    const configPath = join(scratchDir, 'config.yaml');
    await writeFile(
      configPath,
      'package_name_override: client\nproject_name_override: client\n',
      'utf8',
    );

    const outputPath = join(scratchDir, 'out');

    const result = await runUv(
      [
        'openapi-python-client',
        'generate',
        '--path',
        specPath,
        '--meta',
        'none',
        '--config',
        configPath,
        '--output-path',
        outputPath,
        '--custom-template-path',
        CUSTOM_TEMPLATE_PATH,
        '--overwrite',
      ],
      options.toolchainDir,
      options.uvDeps,
    );

    const outputExists = await stat(outputPath)
      .then((s) => s.isDirectory())
      .catch(() => false);

    // A non-zero exit here is expected whenever the generator has to skip an
    // endpoint (see completeness-guard.ts) — it is not on its own a hard
    // failure. Only "produced nothing at all" is: something more fundamental
    // (an invalid spec, a crash) went wrong.
    if (!outputExists) {
      throw new ClientGenerationError(
        `openapi-python-client produced no client at all: ${result.stderr.trim() || 'no output written'}`,
      );
    }

    const clientDir = join(options.targetDir, 'client');
    await copyDir(outputPath, clientDir);

    const document: unknown = JSON.parse(bundledSpec);
    await assertClientCompleteness(extractOperations(document), clientDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
