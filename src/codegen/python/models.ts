import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelGenerationError } from './errors.js';
import { runUv, type UvRunnerDeps } from './uv.js';

export interface GenerateModelsOptions {
  /** The `python/` toolchain directory whose pinned datamodel-code-generator runs. */
  toolchainDir: string;
  /** Where the models are written: either `models.py` or a `models/` package under this directory. */
  targetDir: string;
  uvDeps?: UvRunnerDeps;
}

/**
 * Runs datamodel-code-generator against `bundledSpec` and writes the result
 * under `options.targetDir` as either `models.py` (single-file output, the
 * common case once external refs carry no `$id`/`$schema`) or a `models/`
 * package (directory-mode output, forced when an inlined external schema
 * still carries its own `$id` — see the spike report).
 */
export async function generateModels(
  bundledSpec: string,
  options: GenerateModelsOptions,
): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'speckify-dcg-'));
  try {
    const specPath = join(scratchDir, 'spec.json');
    await writeFile(specPath, bundledSpec, 'utf8');
    const outputDir = join(scratchDir, 'out');

    const result = await runUv(
      [
        'datamodel-codegen',
        '--input',
        specPath,
        '--input-file-type',
        'openapi',
        '--output',
        outputDir,
        '--output-model-type',
        'pydantic_v2.BaseModel',
        '--target-python-version',
        '3.10',
        '--use-schema-description',
        '--enum-field-as-literal',
        'one',
      ],
      options.toolchainDir,
      options.uvDeps,
    );

    const outputStat = await stat(outputDir).catch(() => null);
    if (result.exitCode !== 0 || outputStat === null) {
      throw new ModelGenerationError(
        `datamodel-code-generator failed to produce any models: ${result.stderr.trim() || 'no output written'}`,
      );
    }

    if (outputStat.isFile()) {
      // Single-file mode: datamodel-code-generator itself decides a plain
      // file is enough when nothing forces a module split.
      await mkdir(options.targetDir, { recursive: true });
      const contents = await readFile(outputDir, 'utf8');
      await writeFile(join(options.targetDir, 'models.py'), contents, 'utf8');
    } else {
      // Directory mode: an inlined external schema kept its own `$id`, which
      // forces datamodel-code-generator to treat it as a separate module
      // (see the spike report, section 3). Ship it as a `models/` package
      // rather than trying to flatten cross-module relative imports by hand.
      await copyDir(outputDir, join(options.targetDir, 'models'));
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

async function copyDir(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
    } else {
      const contents = await readFile(sourcePath);
      await writeFile(destinationPath, contents);
    }
  }
}
