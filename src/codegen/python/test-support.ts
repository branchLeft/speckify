import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { parse } from 'yaml';

import { PLACEHOLDER_VERSION } from '../../bundle/index.js';
import { toCanonicalJson } from '../../bundle/canonical-json.js';

/** The `python/` toolchain directory at the repo root, resolved without depending on `cwd`. */
export const TOOLCHAIN_DIR = fileURLToPath(new URL('../../../python', import.meta.url));

/**
 * Loads a spike fixture and re-serialises it exactly the way `bundleSpec`
 * would: canonical, key-sorted JSON with `info.version` stamped. Tests
 * exercise the real shape the driver receives, not the YAML on disk.
 */
export function loadFixtureAsBundledSpec(
  fixtureName: string,
  version: string = PLACEHOLDER_VERSION,
): string {
  const fixturePath = fileURLToPath(new URL(`./fixtures/${fixtureName}`, import.meta.url));
  const document = parse(readFileSync(fixturePath, 'utf8')) as { info: { version: unknown } };
  document.info.version = version;
  return toCanonicalJson(document);
}

/** Whether `uv` is on PATH, for tests that skip themselves rather than fail an environment without it. */
export async function hasUv(): Promise<boolean> {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    try {
      await access(join(dir, 'uv'), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
