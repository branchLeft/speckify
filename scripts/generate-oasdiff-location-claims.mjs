#!/usr/bin/env node
// Derives every rule location oasdiff's catalogue declares, merged by
// pattern. See generate-oasdiff-location-claims.md.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {ReadonlyArray<{ locations?: readonly string[] }>} checks the parsed
 *   contents of `data/oasdiff-<version>.checks.json`.
 * @returns {{ pattern: string, actions: string[] }[]} one entry per distinct
 *   pattern, with the union of its actions; both sorted.
 */
export function deriveLocationClaims(checks) {
  const byPattern = new Map();
  for (const check of checks) {
    for (const location of check.locations ?? []) {
      const separator = location.indexOf(':');
      const pattern = separator === -1 ? location : location.slice(0, separator);
      const actions = separator === -1 ? [] : location.slice(separator + 1).split(',');
      if (pattern === '' || actions.length === 0 || actions.includes('')) {
        throw new Error(`malformed oasdiff location claim: ${JSON.stringify(location)}`);
      }
      const merged = byPattern.get(pattern) ?? new Set();
      for (const action of actions) merged.add(action);
      byPattern.set(pattern, merged);
    }
  }
  return [...byPattern.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pattern, actions]) => ({ pattern, actions: [...actions].sort() }));
}

function dataPath(oasdiffVersion, kind) {
  return join(repoRoot, 'data', `oasdiff-${oasdiffVersion}.${kind}.json`);
}

/** Serialises the file exactly as prettier formats it, so regenerating stays format-clean. */
function serialize(file) {
  const claims = file.claims.map(
    (claim) =>
      `    {\n      "pattern": ${JSON.stringify(claim.pattern)},\n` +
      `      "actions": [${claim.actions.map((a) => JSON.stringify(a)).join(', ')}]\n    }`,
  );
  return (
    `{\n  "oasdiffVersion": ${JSON.stringify(file.oasdiffVersion)},\n` +
    `  "claims": [\n${claims.join(',\n')}\n  ]\n}\n`
  );
}

/** Regenerates `data/oasdiff-<version>.location-claims.json` from the committed catalogue. */
export async function generate(oasdiffVersion) {
  const checks = JSON.parse(await readFile(dataPath(oasdiffVersion, 'checks'), 'utf8'));
  const file = { oasdiffVersion, claims: deriveLocationClaims(checks) };
  await writeFile(dataPath(oasdiffVersion, 'location-claims'), serialize(file), 'utf8');
  return file;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const oasdiffVersion = process.argv[2];
  if (oasdiffVersion === undefined) {
    console.error('usage: generate-oasdiff-location-claims.mjs <oasdiffVersion>');
    process.exit(1);
  }
  const file = await generate(oasdiffVersion);
  console.log(`Wrote ${file.claims.length} location claims for oasdiff ${oasdiffVersion}.`);
}
