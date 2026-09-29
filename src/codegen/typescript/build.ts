import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readdir, symlink } from 'node:fs/promises';
import ts from 'typescript';
import { BuildError } from './errors.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

/**
 * Generated packages need zod 4's API (z.iso, z.int, …), which is installed
 * here under the alias `zod4` so it never collides with the `zod` 3.x
 * speckify itself depends on for its own config validation. Symlinking it
 * (and @types/node) into the generated package's own node_modules makes the
 * package self-contained for compilation regardless of where its directory
 * lives on disk.
 */
async function linkDependency(
  packageDir: string,
  moduleName: string,
  realDir: string,
): Promise<void> {
  const target = path.join(packageDir, 'node_modules', moduleName);
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(realDir, target, 'dir').catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  });
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listSourceFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string[] {
  const host: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => ts.sys.newLine,
  };
  return diagnostics.map((diagnostic) => ts.formatDiagnostic(diagnostic, host).trim());
}

/**
 * Compiles a generated package's `src/` to `dist/` (ESM + .d.ts), using the
 * TypeScript compiler API in-process rather than shelling out to `tsc`, so
 * the generated package needs no `typescript` devDependency of its own.
 *
 * The generated package's tsconfig is strict but deliberately does not set
 * `exactOptionalPropertyTypes`: hey-api's own runtime template (client.gen.ts,
 * core/*.gen.ts) fails that check on its own boilerplate, independent of any
 * producer spec's shapes (confirmed in the conformance spike).
 */
export async function buildPackage(packageDir: string): Promise<void> {
  await Promise.all([
    linkDependency(packageDir, 'zod', path.join(REPO_NODE_MODULES, 'zod4')),
    linkDependency(packageDir, '@types/node', path.join(REPO_NODE_MODULES, '@types', 'node')),
  ]);

  const srcDir = path.join(packageDir, 'src');
  const fileNames = await listSourceFiles(srcDir);

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    outDir: path.join(packageDir, 'dist'),
    rootDir: srcDir,
    declaration: true,
    strict: true,
    exactOptionalPropertyTypes: false,
    skipLibCheck: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
  };

  const program = ts.createProgram(fileNames, compilerOptions);
  const emitResult = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);

  if (errors.length > 0) {
    throw new BuildError(
      `Generated package at ${packageDir} failed to compile with ${errors.length.toString()} error(s).`,
      formatDiagnostics(errors),
    );
  }
}
