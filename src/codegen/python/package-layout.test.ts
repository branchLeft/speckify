import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeProjectFiles } from './package-layout.js';
import type { BuildPythonPackageInput } from './types.js';

const baseInput: BuildPythonPackageInput = {
  bundledSpec: '{"openapi":"3.1.0","info":{"title":"x","version":"1.2.3"}}',
  packageName: 'my-service-api',
  version: '1.2.3',
  client: true,
  server: true,
  changelog: '## 1.2.3\n\n- Initial release.\n',
  speckifyVersion: '0.4.0',
};

describe('writeProjectFiles', () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('writes pyproject.toml with the version, requires-python and [tool.speckify]', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-layout-'));
    await writeProjectFiles(baseInput, projectDir);

    const pyproject = await readFile(join(projectDir, 'pyproject.toml'), 'utf8');
    expect(pyproject).toContain('name = "my-service-api"');
    expect(pyproject).toContain('version = "1.2.3"');
    expect(pyproject).toContain('requires-python = ">=3.10"');
    expect(pyproject).toContain('[tool.speckify]');
    expect(pyproject).toContain('speckify_version = "0.4.0"');
    expect(pyproject).toContain('server = ["fastapi>=0.110"]');
  });

  it('derives the import name by swapping hyphens for underscores', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-layout-'));
    const packageDir = await writeProjectFiles(baseInput, projectDir);

    expect(packageDir).toBe(join(projectDir, 'src', 'my_service_api'));
    await expect(readFile(join(packageDir, 'py.typed'), 'utf8')).resolves.toBe('');
  });

  it('writes the bundled spec as package data', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-layout-'));
    const packageDir = await writeProjectFiles(baseInput, projectDir);

    const openapiJson = await readFile(join(packageDir, 'openapi.json'), 'utf8');
    expect(openapiJson).toBe(baseInput.bundledSpec);
  });

  it('writes the caller-supplied changelog verbatim', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-layout-'));
    await writeProjectFiles(baseInput, projectDir);

    await expect(readFile(join(projectDir, 'CHANGELOG.md'), 'utf8')).resolves.toBe(
      baseInput.changelog,
    );
  });

  it('mentions client and server submodules in the README only when generated', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-layout-'));
    await writeProjectFiles({ ...baseInput, client: false, server: false }, projectDir);

    const readme = await readFile(join(projectDir, 'README.md'), 'utf8');
    expect(readme).not.toContain('.client');
    expect(readme).not.toContain('.server');
  });
});
