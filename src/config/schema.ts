import { z } from 'zod';

// Package names on npm allow scopes and dots; this is deliberately permissive
// and only rejects names npm itself would reject (uppercase, leading dot/underscore).
const NPM_PACKAGE_NAME = /^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/;

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A PEP 503 normalised name lower-cases the name and collapses any run of
 * `-`, `_` or `.` into a single hyphen. A name that already satisfies this
 * is stable under the transform, which is what `python.package` must be.
 */
export function pep503Normalise(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

// A GitHub `owner/repo` slug, as Actions' `GITHUB_REPOSITORY` carries it.
// Each half uses GitHub's own name alphabet; `.` and `..` are path segments,
// not names. `$` is not used because it also matches before a trailing newline.
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/;

/**
 * The repository a generated package names as its source. It ends up inside
 * a URL in the package's `package.json`, so nothing but a plain `owner/repo`
 * is accepted.
 */
export const githubRepositorySchema = z
  .string()
  .regex(GITHUB_REPOSITORY, 'must be "owner/repo"')
  .refine((slug) => slug.split('/').every((part) => !/^\.+$/.test(part)), {
    message: 'must not contain "." or ".." as a name',
  });

/** True for a backslash or any C0 control character or DEL, by code point. */
function hasBackslashOrControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\\' || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * A package's directory within its repository, as `package.json`'s
 * `repository.directory` records it: a relative, forward-slash path whose
 * every segment is a real name. Nothing that could climb out of the
 * repository, name the root, or carry a control character is accepted.
 */
export const repositoryDirectorySchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((directory) => !hasBackslashOrControlCharacter(directory), {
    message: 'must not contain a backslash or a control character',
  })
  .refine(
    (directory) =>
      directory
        .split('/')
        .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    { message: 'must be a relative path with no empty, "." or ".." segment' },
  );

/**
 * `public` or `restricted`, as `npm publish --access` and
 * `publishConfig.access` take it. GitHub Packages takes a package's
 * visibility from its repository and ignores this value, so it only has to
 * be one npm accepts; `restricted` is npm's own default for a scoped
 * package, so leaving it out changes nothing.
 */
export const npmAccessSchema = z.enum(['public', 'restricted']);

const typescriptTargetSchema = z.object({
  package: z.string().regex(NPM_PACKAGE_NAME, 'must be a valid npm package name'),
  client: z.boolean().default(false),
  server: z.boolean().default(false),
});

const pythonTargetSchema = z
  .object({
    package: z.string().min(1, 'must not be empty'),
    client: z.boolean().default(false),
    server: z.boolean().default(false),
  })
  .refine((target) => pep503Normalise(target.package) === target.package, {
    message: 'must already be PEP 503 normalised (lowercase, hyphen-separated)',
    path: ['package'],
  });

const contractSchema = z.object({
  name: z.string().regex(KEBAB_CASE, 'must be kebab-case'),
  spec: z.string().min(1, 'must not be empty'),
  typescript: typescriptTargetSchema.optional(),
  python: pythonTargetSchema.optional(),
});

const githubPackagesSchema = z.object({
  owner: z.string().min(1, 'must not be empty'),
  access: npmAccessSchema.default('restricted'),
});

const publishSchema = z.object({
  githubPackages: githubPackagesSchema,
});

/**
 * GitHub Packages requires an npm package's scope to equal the owner
 * (case-insensitively) it is published under — `@acme/foo` may only publish
 * to the `acme` org or user. This is the one true form of that scope.
 */
export function expectedNpmScope(owner: string): string {
  return `@${owner.toLowerCase()}/`;
}

export const speckifyConfigSchema = z
  .object({
    contracts: z.array(contractSchema).min(1, 'must declare at least one contract'),
    publish: publishSchema,
  })
  .superRefine((config, ctx) => {
    const scope = expectedNpmScope(config.publish.githubPackages.owner);
    config.contracts.forEach((contract, index) => {
      if (contract.typescript !== undefined && !contract.typescript.package.startsWith(scope)) {
        ctx.addIssue({
          code: 'custom',
          message: `must be scoped "${scope}…" to match publish.githubPackages.owner (GitHub Packages requires the package scope to equal the owner)`,
          path: ['contracts', index, 'typescript', 'package'],
        });
      }
    });
  });

export type NpmAccess = z.infer<typeof npmAccessSchema>;
export type TypescriptTarget = z.infer<typeof typescriptTargetSchema>;
export type PythonTarget = z.infer<typeof pythonTargetSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type SpeckifyConfig = z.infer<typeof speckifyConfigSchema>;
