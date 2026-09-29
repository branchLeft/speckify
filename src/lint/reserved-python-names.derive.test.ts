import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CUSTOM_TEMPLATE_PATH } from '../codegen/python/client.js';
import { hasUv, TOOLCHAIN_DIR } from '../codegen/python/test-support.js';
import { runUvOrThrow } from '../codegen/python/uv.js';
import committed from './reserved-python-names.json' with { type: 'json' };

const DERIVE_SCRIPT = fileURLToPath(
  new URL('./python/derive_reserved_model_members.py', import.meta.url),
);

const uvAvailable = await hasUv();
const describeTitle = uvAvailable
  ? 'reserved-python-names.json (drift against the installed toolchain)'
  : 'reserved-python-names.json (drift, SKIPPED: uv not found on PATH)';

// This never hand-maintains the reserved-name lists: it re-runs the exact
// derivation script that produced the committed JSON against whatever
// openapi-python-client/pydantic the pinned toolchain currently has
// installed, and fails if the two disagree — so a `python/uv.lock` bump
// that changes either package's own reserved-name surface is caught here
// rather than silently under- or over-refusing specs afterwards.
describe.skipIf(!uvAvailable)(describeTitle, () => {
  let outputPath: string;
  let scratchDir: string;

  afterEach(async () => {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  it('matches a fresh derivation from the pinned toolchain', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'speckify-reserved-derive-'));
    outputPath = join(scratchDir, 'reserved-python-names.json');

    await runUvOrThrow(['python', DERIVE_SCRIPT, CUSTOM_TEMPLATE_PATH, outputPath], TOOLCHAIN_DIR);

    const derived: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
    // A control case, not just a re-run: the committed file must actually
    // name the four members the blocker was about, so this comparison
    // can't be vacuously true against two independently-empty results.
    expect(committed.openapiPythonClient.modelMembers).toEqual(
      expect.arrayContaining(['to_dict', 'from_dict', 'additional_properties', 'additional_keys']),
    );
    expect(derived).toEqual(committed);
  }, 60_000);
});
