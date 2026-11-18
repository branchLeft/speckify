import path from 'node:path';

import { repositoryDirectorySchema } from './config/index.js';

/**
 * Derives a generated package's `repository.directory` from where its
 * contract lives: the directory that holds the spec, relative to the
 * repository root, with forward slashes. That is the directory of the
 * repository the contract is maintained in.
 *
 * Returns `undefined` — so the field is left out — for a spec at the root
 * (nothing to name), a spec outside the repository, or a path the manifest
 * may not carry (see {@link repositoryDirectorySchema}).
 */
export function repositoryDirectoryFor(repoRoot: string, specPath: string): string | undefined {
  const relative = path.relative(repoRoot, path.dirname(specPath));
  if (relative === '' || path.isAbsolute(relative)) {
    return undefined;
  }
  const segments = relative.split(path.sep);
  if (segments[0] === '..') {
    return undefined;
  }
  const directory = segments.join('/');
  return repositoryDirectorySchema.safeParse(directory).success ? directory : undefined;
}
