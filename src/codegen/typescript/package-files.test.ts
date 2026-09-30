import { describe, expect, it } from 'vitest';
import { buildPackageJson, buildReadme, licenseFromBundledSpec } from './package-files.js';

const base = { packageName: '@acme/widgets', version: '1.2.3', speckifyVersion: '0.1.0' };

describe('buildPackageJson', () => {
  it('always includes ./types and ./zod', () => {
    const pkg = buildPackageJson({ ...base, client: false, server: false });
    expect(pkg.exports).toMatchObject({
      './types': { types: './dist/types.gen.d.ts', import: './dist/types.gen.js' },
      './zod': { types: './dist/zod.gen.d.ts', import: './dist/zod.gen.js' },
    });
    expect(Object.hasOwn(pkg.exports as object, '.')).toBe(false);
    expect(Object.hasOwn(pkg.exports as object, './server')).toBe(false);
  });

  it('adds a "." export only when client is requested', () => {
    const pkg = buildPackageJson({ ...base, client: true, server: false });
    expect(Object.hasOwn(pkg.exports as object, '.')).toBe(true);
  });

  it('adds a "./server" export only when server is requested', () => {
    const pkg = buildPackageJson({ ...base, client: false, server: true });
    expect(Object.hasOwn(pkg.exports as object, './server')).toBe(true);
  });

  // npm only auto-includes package.json, README and the main entry --
  // CHANGELOG.md and openapi.json (written alongside package.json by
  // generate.ts) are otherwise silently dropped from the published
  // tarball, and record/npm.ts's whole "read the last published spec back"
  // model depends on package/openapi.json actually being there.
  it('lists openapi.json, CHANGELOG.md and README.md in files, not just dist', () => {
    const pkg = buildPackageJson({ ...base, client: true, server: true });
    expect(pkg.files).toEqual(
      expect.arrayContaining(['dist', 'openapi.json', 'CHANGELOG.md', 'README.md']),
    );
  });

  it('carries the speckify metadata field', () => {
    const pkg = buildPackageJson({ ...base, client: true, server: true });
    expect(pkg.speckify).toEqual({ speckifyVersion: '0.1.0' });
    expect(pkg.dependencies).toEqual({ zod: '^4.6.5' });
  });

  it('omits license when none is given, sets it when one is', () => {
    const noLicense = buildPackageJson({ ...base, client: true, server: false });
    expect(noLicense).not.toHaveProperty('license');
    const licensed = buildPackageJson({ ...base, client: true, server: false, license: 'MIT' });
    expect(licensed.license).toBe('MIT');
  });
});

describe('buildReadme', () => {
  it('documents the client only when requested', () => {
    const readme = buildReadme({ ...base, client: true, server: false });
    expect(readme).toContain('## Client');
    expect(readme).not.toContain('## Server');
  });

  it('documents the server only when requested', () => {
    const readme = buildReadme({ ...base, client: false, server: true });
    expect(readme).toContain('## Server');
    expect(readme).not.toContain('## Client');
  });
});

describe('licenseFromBundledSpec', () => {
  it('reads a string license', () => {
    expect(licenseFromBundledSpec({ info: { license: 'MIT' } })).toBe('MIT');
  });

  it('reads a license object name', () => {
    expect(licenseFromBundledSpec({ info: { license: { name: 'Apache-2.0' } } })).toBe(
      'Apache-2.0',
    );
  });

  it('returns undefined when there is no license', () => {
    expect(licenseFromBundledSpec({ info: { title: 'x' } })).toBeUndefined();
    expect(licenseFromBundledSpec({})).toBeUndefined();
  });
});
