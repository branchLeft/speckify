#!/usr/bin/env node
// Regenerates `src/oasdiff/binary-checksums.json` for the oasdiff release
// pinned in `src/oasdiff/version.ts`.
//
// oasdiff's own release only publishes SHA-256 sums for the release
// *archives* (`checksums.json`), not for the binaries inside them. Speckify
// verifies the extracted binary on every use (S2), which needs a checksum
// of the binary itself, computed ahead of time and committed to the repo --
// re-downloading and re-extracting the archive on every invocation just to
// re-derive that hash would defeat the point of caching.
//
// This script is the one place that trust boundary is crossed: it downloads
// each release archive, verifies it against the committed archive checksum
// in `checksums.json` (so a compromised download here cannot poison the
// binary table), extracts the binary, and hashes that. Run it by hand after
// bumping `OASDIFF_VERSION` and committing a refreshed `checksums.json`.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTarGzEntry } from '../dist/record/extract-tar-entry.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const oasdiffDir = join(repoRoot, 'src', 'oasdiff');

function binaryNameFor(asset) {
  return asset.includes('_windows_') ? 'oasdiff.exe' : 'oasdiff';
}

async function main() {
  const checksums = JSON.parse(await readFile(join(oasdiffDir, 'checksums.json'), 'utf8'));
  const version = (await readFile(join(oasdiffDir, 'version.ts'), 'utf8')).match(
    /OASDIFF_VERSION = '([^']+)'/,
  )?.[1];
  if (version === undefined) {
    throw new Error('could not read OASDIFF_VERSION from version.ts');
  }

  const binaryChecksums = {};
  for (const [asset, expectedArchiveChecksum] of Object.entries(checksums)) {
    const url = `https://github.com/oasdiff/oasdiff/releases/download/v${version}/${asset}`;
    console.error(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`could not download ${url}: ${String(response.status)}`);
    }
    const archiveBuffer = Buffer.from(await response.arrayBuffer());

    const actualArchiveChecksum = createHash('sha256').update(archiveBuffer).digest('hex');
    if (actualArchiveChecksum !== expectedArchiveChecksum) {
      throw new Error(
        `archive checksum mismatch for ${asset}: expected ${expectedArchiveChecksum}, got ${actualArchiveChecksum}`,
      );
    }

    const binaryName = binaryNameFor(asset);
    const binaryBuffer = await extractTarGzEntry(archiveBuffer, (name) => name === binaryName);
    if (binaryBuffer === null) {
      throw new Error(`archive ${asset} has no "${binaryName}" entry`);
    }

    binaryChecksums[asset] = createHash('sha256').update(binaryBuffer).digest('hex');
  }

  const outPath = join(oasdiffDir, 'binary-checksums.json');
  await writeFile(outPath, `${JSON.stringify(binaryChecksums, null, 2)}\n`);
  console.error(`wrote ${outPath}`);
}

await main();
