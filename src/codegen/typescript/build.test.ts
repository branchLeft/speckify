import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPackage } from './build.js';
import { BuildError } from './errors.js';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];
async function tempPackageDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speckify-build-test-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('buildPackage', () => {
  it('compiles a valid package to dist/ with declarations', async () => {
    const dir = await tempPackageDir();
    await writeFile(path.join(dir, 'src', 'index.ts'), 'export const answer: number = 42;\n');

    await buildPackage(dir);

    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { answer } from '${path.join(dir, 'dist', 'index.js')}'; console.log(answer);`,
    ]);
    expect(stdout.trim()).toBe('42');
  });

  it('raises BuildError with formatted diagnostics for a type error', async () => {
    const dir = await tempPackageDir();
    await writeFile(
      path.join(dir, 'src', 'index.ts'),
      'export const answer: number = "not a number";\n',
    );

    await expect(buildPackage(dir)).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof BuildError &&
        error.diagnostics.length > 0 &&
        error.diagnostics.some((line) => line.includes('not a number') || line.includes('string'))
      );
    });
  });

  it('resolves a zod import via the symlinked zod4 alias', async () => {
    const dir = await tempPackageDir();
    await writeFile(
      path.join(dir, 'src', 'index.ts'),
      "import { z } from 'zod';\nexport const schema = z.object({ id: z.string() });\n",
    );

    await buildPackage(dir);
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { schema } from '${path.join(dir, 'dist', 'index.js')}'; console.log(schema.safeParse({ id: 'x' }).success);`,
    ]);
    expect(stdout.trim()).toBe('true');
  });
});
