import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { generateTypeScriptPackage } from './generate.js';
import type { BundledSpec } from './operations.js';
import { parse as parseYaml } from 'yaml';

const FIXTURES_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'codegen-ts',
);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function typecheck(entryFile: string): string[] {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    esModuleInterop: true,
    noEmit: true,
  };
  const program = ts.createProgram([entryFile], compilerOptions);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  const host: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => ts.sys.newLine,
  };
  return diagnostics.map((d) => ts.formatDiagnostic(d, host).trim());
}

describe('consumer strictness', () => {
  it("the generated .d.ts typecheck under a consumer's strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess + skipLibCheck:false", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'speckify-consumer-'));
    tempDirs.push(outDir);

    const bundledSpec = parseYaml(
      await readFile(path.join(FIXTURES_DIR, 'f-binary-upload.bundled.yaml'), 'utf8'),
    ) as BundledSpec;

    await generateTypeScriptPackage({
      bundledSpec,
      packageName: '@speckify-fixtures/f-binary-upload',
      version: '1.0.0',
      client: true,
      server: true,
      changelog: '',
      speckifyVersion: '0.1.0',
      outDir,
    });

    // A consumer nested inside the package's own tree resolves the
    // package by name via Node's self-reference resolution (the nearest
    // ancestor package.json declares that name), the same way an
    // installed dependency would resolve for a real consumer.
    const consumerDir = path.join(outDir, 'consumer-check');
    await mkdir(consumerDir, { recursive: true });
    const consumerFile = path.join(consumerDir, 'consumer.ts');
    await writeFile(
      consumerFile,
      [
        "import { uploadBlob } from '@speckify-fixtures/f-binary-upload';",
        "import type { UploadBlobResponse } from '@speckify-fixtures/f-binary-upload/types';",
        "import { zUploadBlobResponse } from '@speckify-fixtures/f-binary-upload/zod';",
        "import { createServer, type Handlers } from '@speckify-fixtures/f-binary-upload/server';",
        '',
        "// Client: the SDK function's own argument type must resolve and typecheck.",
        'type UploadBlobArgs = Parameters<typeof uploadBlob>[0];',
        'export function describeClientCall(args: UploadBlobArgs): string {',
        '  return typeof args;',
        '}',
        '',
        '// Server: a real Handlers implementation, exercising the octet-stream body',
        '// as an unbuffered Readable and a zod-validated response body.',
        'const handlers: Handlers = {',
        '  async uploadBlob(request) {',
        '    for await (const _chunk of request.body) {',
        '      // drain the stream',
        '    }',
        "    const body: UploadBlobResponse = { id: 'generated' };",
        '    zUploadBlobResponse.parse(body);',
        '    return { status: 201, body };',
        '  },',
        '};',
        '',
        'export const listener = createServer(handlers);',
        '',
      ].join('\n'),
    );

    const errors = typecheck(consumerFile);
    expect(errors).toEqual([]);
  }, 30_000);
});
