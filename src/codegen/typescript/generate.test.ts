import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile as writeFileFs } from 'node:fs/promises';
import { generateTypeScriptPackage } from './generate.js';
import { CodegenInputError, IncompleteGenerationError } from './errors.js';
import { assertGenerationComplete } from './completeness.js';
import { extractOperations, type BundledSpec } from './operations.js';
import { readSdkFunctionNames } from './read-generated-names.js';

const FIXTURES_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'codegen-ts',
);

async function loadFixture(name: string): Promise<BundledSpec> {
  const text = await readFile(path.join(FIXTURES_DIR, name), 'utf8');
  return parseYaml(text) as BundledSpec;
}

const tempDirs: string[] = [];
async function tempOutDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speckify-codegen-ts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('generateTypeScriptPackage', () => {
  it('writes a complete, buildable client+server package for the combined fixture', async () => {
    const outDir = await tempOutDir();
    const bundledSpec = await loadFixture('combined.bundled.yaml');

    await generateTypeScriptPackage({
      bundledSpec,
      packageName: '@speckify-fixtures/combined',
      version: '1.0.0',
      client: true,
      server: true,
      changelog: '# Changelog\n\n## 1.0.0\n\nInitial release.\n',
      speckifyVersion: '0.1.0',
      outDir,
    });

    const packageJson = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      dependencies: Record<string, string>;
    };
    expect(packageJson.exports).toHaveProperty('./types');
    expect(packageJson.exports).toHaveProperty('./zod');
    expect(packageJson.exports).toHaveProperty('./server');
    expect(packageJson.dependencies.zod).toBe('^4.6.5');

    await expect(readFile(path.join(outDir, 'README.md'), 'utf8')).resolves.toContain('## Server');
    await expect(readFile(path.join(outDir, 'CHANGELOG.md'), 'utf8')).resolves.toContain(
      'Initial release',
    );

    const openapi = JSON.parse(await readFile(path.join(outDir, 'openapi.json'), 'utf8')) as {
      info: { version: string };
    };
    expect(openapi.info.version).toBe('1.0.0');

    // A compiled dist/ for the client SDK, types, zod schemas and server.
    await expect(readFile(path.join(outDir, 'dist', 'index.js'), 'utf8')).resolves.toContain(
      'export',
    );
    await expect(readFile(path.join(outDir, 'dist', 'types.gen.d.ts'), 'utf8')).resolves.toContain(
      'GetThingResponse',
    );
    await expect(readFile(path.join(outDir, 'dist', 'server.js'), 'utf8')).resolves.toContain(
      'createServer',
    );
    await expect(
      readFile(path.join(outDir, 'dist', 'handlers.gen.d.ts'), 'utf8'),
    ).resolves.toContain('Handlers');
  }, 30_000);

  it('rejects when neither client nor server is requested', async () => {
    const outDir = await tempOutDir();
    const bundledSpec = await loadFixture('e-const.bundled.yaml');

    await expect(
      generateTypeScriptPackage({
        bundledSpec,
        packageName: '@speckify-fixtures/e-const',
        version: '1.0.0',
        client: false,
        server: false,
        changelog: '',
        speckifyVersion: '0.1.0',
        outDir,
      }),
    ).rejects.toBeInstanceOf(CodegenInputError);
  });

  it('generates a client-only package for the octet-stream fixture and typechecks the server as unused when server is false', async () => {
    const outDir = await tempOutDir();
    const bundledSpec = await loadFixture('f-binary-upload.bundled.yaml');

    await generateTypeScriptPackage({
      bundledSpec,
      packageName: '@speckify-fixtures/f-binary-upload',
      version: '2.0.0',
      client: true,
      server: false,
      changelog: '',
      speckifyVersion: '0.1.0',
      outDir,
    });

    const packageJson = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(Object.hasOwn(packageJson.exports, './server')).toBe(false);
    await expect(readFile(path.join(outDir, 'dist', 'sdk.gen.js'), 'utf8')).resolves.toContain(
      'uploadBlob',
    );
  }, 30_000);

  it('the completeness guard fires when a real generated SDK is missing an operation (sabotage)', async () => {
    const outDir = await tempOutDir();
    const bundledSpec = await loadFixture('combined.bundled.yaml');
    const operations = extractOperations(bundledSpec);
    const srcDir = path.join(outDir, 'src');

    // Run the real generator, then sabotage its real output by deleting
    // one operation's SDK export — reproducing a generator that silently
    // dropped an endpoint, which is exactly what this guard exists to
    // catch. Everything up to the sabotage is genuine, not fabricated.
    await generateTypeScriptPackage({
      bundledSpec,
      packageName: '@speckify-fixtures/combined-real',
      version: '1.0.0',
      client: true,
      server: false,
      changelog: '',
      speckifyVersion: '0.1.0',
      outDir,
    });
    const sdkPath = path.join(srcDir, 'sdk.gen.ts');
    const original = await readFile(sdkPath, 'utf8');
    const sabotaged = original.replace(/export const createPet =[\s\S]*?\n\n/, '');
    expect(sabotaged).not.toBe(original);
    await writeFileFs(sdkPath, sabotaged);

    const sdkFunctionNames = await readSdkFunctionNames(srcDir);
    expect(() => {
      assertGenerationComplete(operations, { sdkFunctionNames });
    }).toThrow(IncompleteGenerationError);

    try {
      assertGenerationComplete(operations, { sdkFunctionNames });
      expect.fail('expected assertGenerationComplete to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteGenerationError);
      expect((error as IncompleteGenerationError).missingOperationIds).toEqual(['createPet']);
    }
  }, 30_000);
});
