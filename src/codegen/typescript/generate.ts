import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildPackage } from './build.js';
import { assertGenerationComplete } from './completeness.js';
import { CodegenInputError } from './errors.js';
import { runHeyApi } from './heyapi.js';
import { extractOperations, type BundledSpec } from './operations.js';
import {
  buildPackageJson,
  buildReadme,
  licenseFromBundledSpec,
  type PackageFilesInput,
} from './package-files.js';
import { readHandlerMethodNames, readSdkFunctionNames } from './read-generated-names.js';
import { writeServer } from './server/write-server.js';

export interface GenerateInput {
  readonly bundledSpec: BundledSpec;
  readonly packageName: string;
  readonly version: string;
  readonly client: boolean;
  readonly server: boolean;
  readonly changelog: string;
  readonly speckifyVersion: string;
  /** Where to write the package; the directory is created if it doesn't exist. */
  readonly outDir: string;
}

function withVersion(spec: BundledSpec, version: string): Record<string, unknown> {
  return { ...spec, info: { ...spec.info, version } };
}

/**
 * Generates a complete, buildable TypeScript npm package for one bundled
 * OpenAPI contract: the @hey-api/openapi-ts client/types/zod output, an
 * optional Speckify-authored server (Handlers interface + node:http
 * adapter), package metadata, and a compiled `dist/`.
 */
export async function generateTypeScriptPackage(input: GenerateInput): Promise<void> {
  if (!input.client && !input.server) {
    throw new CodegenInputError('At least one of client or server must be requested.');
  }

  const operations = extractOperations(input.bundledSpec);
  const srcDir = path.join(input.outDir, 'src');
  await mkdir(srcDir, { recursive: true });

  await runHeyApi(input.bundledSpec, srcDir);
  if (input.server) {
    await writeServer(srcDir, operations);
  }

  const sdkFunctionNames = await readSdkFunctionNames(srcDir);
  const handlerMethodNames = input.server ? await readHandlerMethodNames(srcDir) : undefined;
  assertGenerationComplete(operations, {
    sdkFunctionNames,
    ...(handlerMethodNames ? { handlerMethodNames } : {}),
  });

  const license = licenseFromBundledSpec(input.bundledSpec);
  const packageFilesInput: PackageFilesInput = {
    packageName: input.packageName,
    version: input.version,
    client: input.client,
    server: input.server,
    speckifyVersion: input.speckifyVersion,
    ...(license === undefined ? {} : { license }),
  };

  await Promise.all([
    writeFile(
      path.join(input.outDir, 'package.json'),
      JSON.stringify(buildPackageJson(packageFilesInput), null, 2) + '\n',
    ),
    writeFile(path.join(input.outDir, 'README.md'), buildReadme(packageFilesInput)),
    writeFile(path.join(input.outDir, 'CHANGELOG.md'), input.changelog),
    writeFile(
      path.join(input.outDir, 'openapi.json'),
      JSON.stringify(withVersion(input.bundledSpec, input.version), null, 2) + '\n',
    ),
  ]);

  await buildPackage(input.outDir);
}
