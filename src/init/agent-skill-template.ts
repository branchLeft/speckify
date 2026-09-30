import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirrors the `packageRoot` pattern in `../cli.ts`: `templates/`, like
// `data/` and `python/`, ships as a top-level directory alongside `dist/`
// (see `files` in package.json), not compiled or bundled -- so it's read
// from disk at runtime, two levels up from this file's own directory,
// which resolves the same way from `src/init` (vitest) and `dist/init`
// (the published package).
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..', '..');
const TEMPLATE_PATH = path.join(packageRoot, 'templates', 'agent-skill', 'SKILL.md');

/** Reads the shipped agent skill template (`templates/agent-skill/SKILL.md`) verbatim. */
export async function readAgentSkillTemplate(): Promise<string> {
  return readFile(TEMPLATE_PATH, 'utf8');
}
