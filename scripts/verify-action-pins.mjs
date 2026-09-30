#!/usr/bin/env node
// A `uses: owner/repo@<sha> # vX.Y.Z` pin is only as trustworthy as the
// claim that <sha> is actually what vX.Y.Z points to. Two ways that claim
// goes silently wrong: the tag moved since the pin was written (this is
// exactly what a SHA pin is meant to guard against, but only if the SHA is
// right in the first place), or the pin was written from the *tag object*
// itself rather than the commit it points at -- an annotated tag's own SHA
// is a valid ref (Actions resolves it), but `git ls-remote` reports it
// separately from `refs/tags/vX.Y.Z^{}}`, the dereferenced commit, and
// they are almost never the same value. This script resolves every real
// `uses:` pin's tag against its actual repo and reports any mismatch.
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// `uses: owner/repo@<40-hex-sha> # vX.Y.Z` -- the only shape this checks;
// a local action (`uses: ./path`) or an unpinned/floating ref is out of
// scope (nothing to resolve a commit against).
const USES_PATTERN = /uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\s*#\s*(v[0-9][\w.-]*)/g;

async function findWorkflowFiles() {
  const files = [join(repoRoot, 'action.yml')];
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const entries = await readdir(workflowsDir).catch(() => []);
  for (const entry of entries) {
    if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
      files.push(join(workflowsDir, entry));
    }
  }
  return files;
}

/** Every `uses:` pin found across action.yml and .github/workflows/*.yml. */
export async function findPins() {
  const files = await findWorkflowFiles();
  const pins = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    for (const match of text.matchAll(USES_PATTERN)) {
      const [, repo, sha, tag] = match;
      pins.push({ file, repo, sha, tag });
    }
  }
  return pins;
}

/**
 * The commit a tag actually points to: the dereferenced `^{}` commit for an
 * annotated tag, or the tag ref itself for a lightweight one.
 */
async function resolveTagCommit(repo, tag) {
  const { stdout } = await execFileAsync('git', [
    'ls-remote',
    '--tags',
    `https://github.com/${repo}`,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, ref] = line.split('\t');
      return { sha, ref };
    });
  const dereferenced = lines.find((line) => line.ref.endsWith('^{}'));
  const direct = lines.find((line) => line.ref === `refs/tags/${tag}`);
  return dereferenced?.sha ?? direct?.sha ?? null;
}

async function networkAvailable() {
  try {
    await execFileAsync(
      'git',
      ['ls-remote', '--exit-code', 'https://github.com/actions/checkout'],
      {
        timeout: 5000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves every pin's actual tag commit and reports mismatches. Returns
 * `{ skipped: true, reason }` when there is no network to resolve against
 * (never a false "all clear").
 */
export async function verifyActionPins() {
  if (!(await networkAvailable())) {
    return { skipped: true, reason: 'no network access to github.com', mismatches: [] };
  }

  const pins = await findPins();
  const mismatches = [];
  for (const pin of pins) {
    const actual = await resolveTagCommit(pin.repo, pin.tag);
    if (actual === null) {
      mismatches.push({ ...pin, actual, reason: `tag ${pin.tag} not found on ${pin.repo}` });
    } else if (actual !== pin.sha) {
      mismatches.push({ ...pin, actual, reason: 'pinned sha does not match the tag commit' });
    }
  }
  return { skipped: false, mismatches };
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const result = await verifyActionPins();
  if (result.skipped) {
    console.log(`SKIPPED: ${result.reason}`);
    process.exit(0);
  }
  if (result.mismatches.length === 0) {
    console.log('All action pins match their tagged commit.');
    process.exit(0);
  }
  for (const mismatch of result.mismatches) {
    console.error(
      `${mismatch.file}: ${mismatch.repo}@${mismatch.sha} # ${mismatch.tag} -- ${mismatch.reason}` +
        (mismatch.actual ? ` (actual: ${mismatch.actual})` : ''),
    );
  }
  process.exit(1);
}
