import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { extractOperations } from './operations.js';
import { runUvOrThrow, type UvRunnerDeps } from './uv.js';

const RENDER_SCRIPT = fileURLToPath(new URL('./templates/render_server.py', import.meta.url));

export interface GenerateServerOptions {
  /** The `python/` toolchain directory (its jinja2 dependency renders the templates). */
  toolchainDir: string;
  /** Where the `server/` submodule is written: `<targetDir>/server/`. */
  targetDir: string;
  uvDeps?: UvRunnerDeps;
}

/**
 * Renders the `server/` submodule — the `Handlers` Protocol and
 * `create_router()` — from the bundled spec's operations, via the tested
 * Jinja2 templates in `./templates/`.
 */
export async function generateServer(
  bundledSpec: string,
  options: GenerateServerOptions,
): Promise<void> {
  const document: unknown = JSON.parse(bundledSpec);
  const operations = extractOperations(document);

  const scratchDir = await mkdtemp(join(tmpdir(), 'speckify-server-'));
  try {
    const operationsPath = join(scratchDir, 'operations.json');
    await writeFile(
      operationsPath,
      JSON.stringify(
        operations.map((op) => ({
          operationId: op.operationId,
          method: op.method,
          path: op.path,
          pathParams: op.pathParams,
          queryParams: op.queryParams,
          headerParams: op.headerParams,
          requestBody: op.requestBody,
          responses: op.responses,
        })),
      ),
      'utf8',
    );

    const serverDir = join(options.targetDir, 'server');
    await runUvOrThrow(
      ['python', RENDER_SCRIPT, operationsPath, serverDir],
      options.toolchainDir,
      options.uvDeps,
    );
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
