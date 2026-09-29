import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { loadConfig } from './loader.js';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speckify-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses and validates a well-formed file', async () => {
    const path = join(dir, 'speckify.yaml');
    await writeFile(
      path,
      [
        'contracts:',
        '  - name: orders-api',
        '    spec: ./openapi.yaml',
        '    typescript:',
        '      package: "@acme/orders-api"',
        '      client: true',
        'publish:',
        '  githubPackages:',
        '    owner: acme',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = await loadConfig(path);
    expect(config.contracts).toHaveLength(1);
    expect(config.contracts[0]?.name).toBe('orders-api');
    expect(config.publish.githubPackages.owner).toBe('acme');
  });

  it('throws ConfigError with the file path when the file does not exist', async () => {
    await expect(loadConfig(join(dir, 'missing.yaml'))).rejects.toThrow(ConfigError);
    await expect(loadConfig(join(dir, 'missing.yaml'))).rejects.toThrow(/could not read/);
  });

  it('throws ConfigError with a line and column on invalid YAML', async () => {
    const path = join(dir, 'speckify.yaml');
    await writeFile(path, 'contracts:\n  - name: [unterminated\n', 'utf8');

    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
    await expect(loadConfig(path)).rejects.toThrow(/line \d+, column \d+/);
  });

  it('throws ConfigError listing the field path on schema validation failure', async () => {
    const path = join(dir, 'speckify.yaml');
    await writeFile(
      path,
      ['contracts:', '  - name: Bad_Name', '    spec: x', ''].join('\n'),
      'utf8',
    );

    await expect(loadConfig(path)).rejects.toThrow(/contracts\.0\.name/);
  });

  it('throws ConfigError on a duplicate contract name', async () => {
    const path = join(dir, 'speckify.yaml');
    await writeFile(
      path,
      [
        'contracts:',
        '  - name: orders-api',
        '    spec: a.yaml',
        '  - name: orders-api',
        '    spec: b.yaml',
        'publish:',
        '  githubPackages:',
        '    owner: acme',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(loadConfig(path)).rejects.toThrow(/duplicate contract name/);
  });
});
