/**
 * The single oasdiff release every part of Speckify is pinned to: the
 * binary download (`binary.ts`), the classification map, and the rule
 * catalogue (`version/classification-map.ts`) all key their file names off
 * this one constant. Bumping it here without also shipping a matching
 * `data/oasdiff-<version>.classification.json` and
 * `data/oasdiff-<version>.checks.json` fails loudly at load time (the file
 * simply doesn't exist), rather than silently classifying a new oasdiff
 * release's changes against an old, incomplete map.
 */
export const OASDIFF_VERSION = '1.32.1';

/** The classification map's file name for {@link OASDIFF_VERSION}, inside `data/`. */
export const OASDIFF_CLASSIFICATION_MAP_FILENAME = `oasdiff-${OASDIFF_VERSION}.classification.json`;

/** The full oasdiff rule catalogue's file name for {@link OASDIFF_VERSION}, inside `data/`. */
export const OASDIFF_CHECKS_FILENAME = `oasdiff-${OASDIFF_VERSION}.checks.json`;

/**
 * The covered-keywords file's name for {@link OASDIFF_VERSION}, inside
 * `data/` -- see `scripts/generate-oasdiff-covered-keywords.mjs` and
 * `version/covered-keywords.ts`.
 */
export const OASDIFF_COVERED_KEYWORDS_FILENAME = `oasdiff-${OASDIFF_VERSION}.covered-keywords.json`;
