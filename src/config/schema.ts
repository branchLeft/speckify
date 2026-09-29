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
          code: z.ZodIssueCode.custom,
          message: `must be scoped "${scope}…" to match publish.githubPackages.owner (GitHub Packages requires the package scope to equal the owner)`,
          path: ['contracts', index, 'typescript', 'package'],
        });
      }
    });
  });

export type TypescriptTarget = z.infer<typeof typescriptTargetSchema>;
export type PythonTarget = z.infer<typeof pythonTargetSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type SpeckifyConfig = z.infer<typeof speckifyConfigSchema>;
