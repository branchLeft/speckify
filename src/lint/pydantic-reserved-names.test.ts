import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hasUv, TOOLCHAIN_DIR } from '../codegen/python/test-support.js';
import { runUvOrThrow } from '../codegen/python/uv.js';
import { PYDANTIC_BASE_MODEL_MEMBERS } from './reserved-python-names.js';

const uvAvailable = await hasUv();
const describeTitle = uvAvailable
  ? 'datamodel-code-generator vs pydantic.BaseModel members (integration)'
  : 'datamodel-code-generator vs pydantic.BaseModel members (SKIPPED: uv not found on PATH)';

/**
 * Unlike openapi-python-client's attrs models (the real blocker,
 * `reserved-python-model-member.ts`), datamodel-code-generator already
 * renames a colliding property away from every `pydantic.BaseModel` member
 * (`dict` -> `dict_`, aliased) rather than letting it shadow one.
 */
// This proves that defence still covers the installed pydantic's whole
// public surface: if a future pydantic release adds a method
// datamodel-code-generator doesn't yet know to rename away from, this fails
// and that name needs a lint rule of its own, mirroring the attrs one.
describe.skipIf(!uvAvailable)(describeTitle, () => {
  let scratchDir: string;

  afterEach(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  it('renames every pydantic.BaseModel member away when used as a property name', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'speckify-pydantic-reserved-'));
    const names = [...PYDANTIC_BASE_MODEL_MEMBERS].sort();
    const properties = Object.fromEntries(names.map((name) => [name, { type: 'string' }]));
    const spec = {
      openapi: '3.0.3',
      info: { title: 'reserved-member-probe', version: '0.0.0' },
      paths: {},
      components: { schemas: { Thing: { type: 'object', properties } } },
    };
    const specPath = join(scratchDir, 'spec.json');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');
    const outputPath = join(scratchDir, 'models.py');

    await runUvOrThrow(
      [
        'datamodel-codegen',
        '--input',
        specPath,
        '--input-file-type',
        'openapi',
        '--output',
        outputPath,
        '--output-model-type',
        'pydantic_v2.BaseModel',
        '--target-python-version',
        '3.10',
        '--use-schema-description',
        '--enum-field-as-literal',
        'one',
      ],
      TOOLCHAIN_DIR,
    );

    const generated = await readFile(outputPath, 'utf8');
    const declaredFieldNames = [...generated.matchAll(/^\s{4}(\w+): /gm)].map((m) => m[1]);
    for (const name of names) {
      expect(declaredFieldNames).not.toContain(name);
      expect(declaredFieldNames).toContain(`${name}_`);
      expect(generated).toContain(`alias='${name}'`);
    }
  }, 60_000);

  it('leaves an ordinary property name untouched, as a control', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'speckify-pydantic-reserved-control-'));
    const spec = {
      openapi: '3.0.3',
      info: { title: 'reserved-member-probe', version: '0.0.0' },
      paths: {},
      components: {
        schemas: { Thing: { type: 'object', properties: { nickname: { type: 'string' } } } },
      },
    };
    const specPath = join(scratchDir, 'spec.json');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');
    const outputPath = join(scratchDir, 'models.py');
    await mkdir(scratchDir, { recursive: true });

    await runUvOrThrow(
      [
        'datamodel-codegen',
        '--input',
        specPath,
        '--input-file-type',
        'openapi',
        '--output',
        outputPath,
        '--output-model-type',
        'pydantic_v2.BaseModel',
        '--target-python-version',
        '3.10',
      ],
      TOOLCHAIN_DIR,
    );

    const generated = await readFile(outputPath, 'utf8');
    expect(generated).toContain('nickname:');
    expect(generated).not.toContain("alias='nickname'");
  }, 60_000);
});
