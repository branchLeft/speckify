/**
 * `owner/repo` hosting Speckify itself — where `init` resolves the reusable
 * workflow's pin, and the only value that string should ever be written as.
 * The `speckify` GitHub org belongs to an unrelated third party, so a
 * generated workflow pointing there instead of here is a supply-chain hole,
 * not just a wrong link.
 */
export const SPECKIFY_REPO = 'branchLeft/speckify';

/**
 * The npm registry GitHub Packages serves. Every generated TypeScript
 * package names it in `publishConfig.registry`, and `speckify publish`
 * passes the same value to `npm publish --registry`, so the two can never
 * disagree about where a package goes.
 */
export const GITHUB_PACKAGES_REGISTRY = 'https://npm.pkg.github.com';
