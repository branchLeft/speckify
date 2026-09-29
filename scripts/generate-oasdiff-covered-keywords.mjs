#!/usr/bin/env node
// Derives the set of JSON-Schema/OpenAPI *keywords* oasdiff's own rule
// catalogue ever looks at, from the same committed rule catalogue
// (`data/oasdiff-<version>.checks.json`, itself the verbatim output of
// oasdiff's `checks changelog --format json`) that
// `version/classification-map-completeness.test.ts` already cross-checks
// against the live binary.
//
// Each rule declares its `locations` as oasdiff's own
// "pattern:action[,action...]" claims (see the oasdiff source,
// checker/rules.go and checker/metaschema/claim.go, at the pinned tag) --
// e.g. "paths.*.*.requestBody.content.*.schema.deprecated:set". The
// keyword a rule actually judges is the pattern's last concrete (non-"*",
// non-"**") path segment: "deprecated" there. A pattern that *ends* in a
// wildcard, e.g. "paths.*.*.requestBody.content.*.schema.properties.*",
// names a whole family of arbitrarily-named children (property names,
// schema names, path templates, ...) rather than a keyword itself; the
// keyword there is the nearest concrete segment before the wildcard
// ("properties").
//
// plan.ts's structural fallback (src/plan.ts) uses this set the other way
// round: a real structural difference at a keyword *not* in this set is one
// oasdiff has no rule for at all, and can never under-bump on its own
// account -- Speckify forces major rather than trust silence there.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The last concrete (non-wildcard) path segment of one location pattern. */
function keywordOf(pattern) {
  const segments = pattern.split('.');
  while (
    segments.length > 1 &&
    (segments[segments.length - 1] === '*' || segments[segments.length - 1] === '**')
  ) {
    segments.pop();
  }
  return segments[segments.length - 1];
}

/**
 * @param {ReadonlyArray<{ locations?: readonly string[] }>} checks the
 *   parsed contents of `data/oasdiff-<version>.checks.json`.
 * @returns {string[]} every covered keyword, deduplicated and sorted.
 */
export function deriveCoveredKeywords(checks) {
  const keywords = new Set();
  for (const check of checks) {
    for (const location of check.locations ?? []) {
      const [pattern] = location.split(':');
      if (pattern === undefined || pattern === '') {
        continue;
      }
      keywords.add(keywordOf(pattern));
    }
  }
  return [...keywords].sort();
}

async function checksPathFor(oasdiffVersion) {
  return join(repoRoot, 'data', `oasdiff-${oasdiffVersion}.checks.json`);
}

async function coveredKeywordsPathFor(oasdiffVersion) {
  return join(repoRoot, 'data', `oasdiff-${oasdiffVersion}.covered-keywords.json`);
}

/** Regenerates `data/oasdiff-<version>.covered-keywords.json` from the committed checks catalogue. */
export async function generate(oasdiffVersion) {
  const checks = JSON.parse(await readFile(await checksPathFor(oasdiffVersion), 'utf8'));
  const keywords = deriveCoveredKeywords(checks);
  const file = { oasdiffVersion, keywords };
  await writeFile(
    await coveredKeywordsPathFor(oasdiffVersion),
    JSON.stringify(file, null, 2) + '\n',
    'utf8',
  );
  return file;
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const oasdiffVersion = process.argv[2];
  if (oasdiffVersion === undefined) {
    console.error('usage: generate-oasdiff-covered-keywords.mjs <oasdiffVersion>');
    process.exit(1);
  }
  const file = await generate(oasdiffVersion);
  console.log(`Wrote ${file.keywords.length} covered keywords for oasdiff ${oasdiffVersion}.`);
}
