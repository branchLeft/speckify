#!/usr/bin/env node
// `tsc` only emits compiled JS/declarations; it never copies a .ts file
// verbatim, and it does not touch non-TS files at all. Some of what
// Speckify reads at runtime is neither: the TS server-adapter template is
// read as raw source text (copied byte-for-byte into a generated package,
// never imported as a module), and the Python codegen's server templates
// (render_server.py, its .jinja files, operations.py) are only ever run by
// `uv run python <script>`, not compiled by tsc at all. Both are missing
// from `dist/` after a plain `tsc` build, so `pnpm build` runs this
// afterwards to carry them across, mirroring their `src/` paths under `dist/`.
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  {
    from: join(repoRoot, 'src', 'codegen', 'typescript', 'templates', 'server-adapter.template.ts'),
    to: join(repoRoot, 'dist', 'codegen', 'typescript', 'templates', 'server-adapter.template.ts'),
  },
  {
    from: join(repoRoot, 'src', 'codegen', 'python', 'templates'),
    to: join(repoRoot, 'dist', 'codegen', 'python', 'templates'),
    // Excludes this directory's own test file, its fixtures (only that
    // test's own input data) and any cached bytecode -- none of it is read
    // at runtime by render_server.py.
    filter: (path) =>
      !path.includes('__pycache__') &&
      !path.includes('fixtures') &&
      !path.includes('test_render_server.py'),
  },
  {
    // The generated-surface diff's griffe extractor, run by `uv run python`.
    from: join(repoRoot, 'src', 'surface', 'python', 'extract_surface.py'),
    to: join(repoRoot, 'dist', 'surface', 'python', 'extract_surface.py'),
  },
];

for (const asset of assets) {
  await cp(asset.from, asset.to, {
    recursive: true,
    filter: asset.filter,
  });
}
