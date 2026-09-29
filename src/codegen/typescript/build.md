# TypeScript code generation build

## Package directory resolution

`resolvePackageDir()` resolves the on-disk directory a package installed, from Speckify's own module resolution — never a hardcoded path relative to this repo.

Resolving `<name>/package.json` (rather than the package's main entry) works even for a package with no importable entry point, and walks whatever `node_modules` tree actually holds it: this repo's own, a parent repo's when Speckify is installed as a dependency, or a pnpm/npx content store when Speckify itself was installed from a tarball or via npx.

This approach ensures the function works in all installation contexts: development (symlink), npm install (real tree), and tool installation (store).
