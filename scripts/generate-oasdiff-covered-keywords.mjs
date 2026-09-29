#!/usr/bin/env node
// Derives the set of JSON-Schema/OpenAPI keywords oasdiff's rules catalogue
// judges, from the same committed rule catalogue plan.ts's structural fallback
// relies on. See generate-oasdiff-covered-keywords.md for how oasdiff patterns
// map to keywords and how this script feeds plan.ts's fallback.
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
