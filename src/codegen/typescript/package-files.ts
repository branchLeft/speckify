import type { NpmAccess } from '../../config/index.js';
import { GITHUB_PACKAGES_REGISTRY } from '../../constants.js';

export interface PackageFilesInput {
  readonly packageName: string;
  readonly version: string;
  readonly client: boolean;
  readonly server: boolean;
  readonly speckifyVersion: string;
  readonly license?: string;
  /**
   * The GitHub `owner/repo` the package is published from, already validated.
   * Absent on a local run, where there is no repository to name.
   */
  readonly repository?: string;
  /**
   * Where the package lives inside `repository`, already validated and
   * relative to the repository root. Only written alongside `repository`.
   */
  readonly repositoryDirectory?: string;
  /** `publishConfig.access`; `restricted`, npm's own default for a scoped package, when absent. */
  readonly access?: NpmAccess;
}

function licenseFromInfo(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const license = (info as { license?: unknown }).license;
  if (typeof license === 'string') return license;
  if (typeof license === 'object' && license !== null && 'name' in license) {
    const name = (license as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

/** Reads `info.license` off a bundled spec, per the `openapi.json` license-in-package-json rule. */
export function licenseFromBundledSpec(spec: { readonly info?: unknown }): string | undefined {
  return licenseFromInfo(spec.info);
}

/**
 * Builds the generated package's `package.json`. `.` exports the client SDK
 * (only when `client` is requested); `./types` and `./zod` always exist,
 * since hey-api always emits `types.gen.ts` and `zod.gen.ts`; `./server`
 * exists only when `server` is requested.
 */
export function buildPackageJson(input: PackageFilesInput): Record<string, unknown> {
  const exports: Record<string, unknown> = {
    './types': { types: './dist/types.gen.d.ts', import: './dist/types.gen.js' },
    './zod': { types: './dist/zod.gen.d.ts', import: './dist/zod.gen.js' },
  };
  if (input.client) {
    exports['.'] = { types: './dist/index.d.ts', import: './dist/index.js' };
  }
  if (input.server) {
    exports['./server'] = { types: './dist/server.d.ts', import: './dist/server.js' };
  }

  const packageJson: Record<string, unknown> = {
    name: input.packageName,
    version: input.version,
    type: 'module',
    exports,
    // npm only auto-includes package.json, README and the main entry;
    // CHANGELOG.md and openapi.json are written to the package root
    // alongside package.json (see generate.ts) and would otherwise be
    // silently dropped from the published tarball -- and
    // record/npm.ts depends on package/openapi.json actually being there.
    files: ['dist', 'openapi.json', 'CHANGELOG.md', 'README.md'],
    dependencies: { zod: '^4.6.5' },
    // `npm publish` takes the registry from here, so the package publishes to
    // GitHub Packages with no `--registry` flag and no hand-edited manifest.
    publishConfig: { registry: GITHUB_PACKAGES_REGISTRY, access: input.access ?? 'restricted' },
    speckify: { speckifyVersion: input.speckifyVersion },
  };
  if (input.license !== undefined) {
    packageJson.license = input.license;
  }
  if (input.repository !== undefined) {
    // GitHub Packages links a package to its repository through this field.
    packageJson.repository = {
      type: 'git',
      url: `git+https://github.com/${input.repository}.git`,
      ...(input.repositoryDirectory === undefined ? {} : { directory: input.repositoryDirectory }),
    };
  }
  return packageJson;
}

/** Builds a minimal install/usage README covering whichever of client/server were generated. */
export function buildReadme(input: PackageFilesInput): string {
  const sections: string[] = [
    `# ${input.packageName}`,
    '',
    '## Install',
    '',
    '```sh',
    `npm install ${input.packageName}`,
    '```',
  ];

  if (input.client) {
    sections.push(
      '',
      '## Client',
      '',
      '```ts',
      `import { client } from '${input.packageName}';`,
      '',
      "client.setConfig({ baseUrl: 'https://example.com' });",
      '```',
    );
  }

  if (input.server) {
    sections.push(
      '',
      '## Server',
      '',
      '```ts',
      `import { createServer, type Handlers } from '${input.packageName}/server';`,
      '',
      'const handlers: Handlers = {',
      '  // one method per operation',
      '};',
      '',
      'const listener = createServer(handlers);',
      "// require('node:http').createServer(listener).listen(3000);",
      '```',
    );
  }

  return sections.join('\n') + '\n';
}
