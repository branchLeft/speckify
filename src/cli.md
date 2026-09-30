# CLI entry point

## Symlink resolution and argv handling

The `isRunningAsMain()` guard allows this file to be imported (e.g., `resolveToolchainImpactBump` from a unit test) without also parsing the importing process's own argv as a speckify invocation.

`process.argv[1]` is compared through its realpath, not raw: npm always installs a package's `bin` entry as a symlink (`node_modules/.bin/speckify -> ../speckify/dist/cli.js`), so a real install invokes this file via that symlink.

Node resolves `import.meta.url` through the symlink to this file's real path, but leaves `process.argv[1]` as the symlink path the shell actually ran. Comparing the two without resolving both the same way never matches for an installed package, so this branch silently never runs and the CLI exits 0 having parsed nothing.

This mismatch is the entire reason we use realpath on both, making the comparison work for both symlink and direct invocations.

## getConfigStringValue

`getConfigStringValue()` reads a dotted-path value (e.g., `publish.githubPackages.owner`) from an already-validated config object. It resolves the path through nested plain objects and returns the final value only if it is a string; otherwise returns undefined.

The function is exported for its own unit test, independent of the CLI/config-loading plumbing around it. It validates that every segment up to the last resolves to a plain object, since the config structure is always objects all the way down.
