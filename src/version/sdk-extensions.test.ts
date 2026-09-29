import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasUv, TOOLCHAIN_DIR } from '../codegen/python/test-support.js';
import { runUvOrThrow } from '../codegen/python/uv.js';
import { isSdkExtension } from './allow-list.js';

// Every `x-` literal the pinned generators read must be one the allow-list
// treats as SDK-affecting (major), so a generator upgrade that starts
// reading a new extension fails here rather than shipping it as a patch.

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.py']);
const LITERAL = /(["'`])(x-[A-Za-z0-9_-]+)\1/g;

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '__pycache__') {
      found.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

async function extensionLiterals(dirs: readonly string[]): Promise<Set<string>> {
  const literals = new Set<string>();
  for (const dir of dirs) {
    for (const file of await sourceFiles(dir)) {
      for (const match of (await readFile(file, 'utf8')).matchAll(LITERAL)) {
        if (match[2] !== undefined) literals.add(match[2]);
      }
    }
  }
  return literals;
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const uvAvailable = await hasUv();

describe('the SDK-affecting extension list', () => {
  it('includes every x- literal @hey-api/openapi-ts and its @hey-api packages read', async () => {
    const heyApi = await realpath(join(repoRoot, 'node_modules', '@hey-api', 'openapi-ts'));
    const scope = dirname(heyApi);
    const packages = await Promise.all(
      (await readdir(scope)).map(async (name) => realpath(join(scope, name, 'dist'))),
    );
    const literals = await extensionLiterals(packages);
    expect(literals.has('x-enum-varnames')).toBe(true);
    expect([...literals].filter((literal) => !isSdkExtension(literal))).toEqual([]);
  });

  it.skipIf(!uvAvailable)(
    'includes every x- literal openapi-python-client and datamodel-code-generator read',
    async () => {
      const script =
        'import os, openapi_python_client as a, datamodel_code_generator as b; ' +
        'print(os.path.dirname(a.__file__)); print(os.path.dirname(b.__file__))';
      const { stdout } = await runUvOrThrow(['python', '-c', script], TOOLCHAIN_DIR);
      const literals = await extensionLiterals(stdout.trim().split('\n'));
      expect(literals.has('x-python-type')).toBe(true);
      expect([...literals].filter((literal) => !isSdkExtension(literal))).toEqual([]);
    },
    120_000,
  );
});
