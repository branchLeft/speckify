/**
 * `owner/repo` hosting Speckify itself — where `init` resolves the reusable
 * workflow's pin, and the only value that string should ever be written as.
 * The `speckify` GitHub org belongs to an unrelated third party, so a
 * generated workflow pointing there instead of here is a supply-chain hole,
 * not just a wrong link.
 */
export const SPECKIFY_REPO = 'branchLeft/speckify';
