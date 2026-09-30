import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { generateHandlersSource } from './generate-handlers.js';
import { generateRoutesSource } from './generate-routes.js';
import { generateServerEntrySource } from './generate-server-entry.js';
import type { OperationInfo } from '../operations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(here, '..', 'templates', 'server-adapter.template.ts');

/**
 * Writes the server half of a generated package into `srcDir`: the copied
 * adapter (self-contained, no Speckify runtime dependency), the generated
 * Handlers interface, the runtime route table, and the small `server.ts`
 * entry point that wires them together.
 */
export async function writeServer(
  srcDir: string,
  operations: readonly OperationInfo[],
): Promise<void> {
  const adapterSource = await readFile(TEMPLATE_PATH, 'utf8');
  await Promise.all([
    writeFile(path.join(srcDir, 'server-adapter.ts'), adapterSource),
    writeFile(path.join(srcDir, 'handlers.gen.ts'), generateHandlersSource(operations)),
    writeFile(path.join(srcDir, 'routes.gen.ts'), generateRoutesSource(operations)),
    writeFile(path.join(srcDir, 'server.ts'), generateServerEntrySource()),
  ]);
}
