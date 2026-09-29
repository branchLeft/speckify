import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertClientCompleteness } from './completeness-guard.js';
import { CompletenessGuardError } from './errors.js';
import type { OperationInfo } from './types.js';

function operation(operationId: string): OperationInfo {
  return {
    operationId,
    method: 'GET',
    path: '/x',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: 'none' },
    responses: [],
  };
}

async function makeClientDir(stems: readonly string[]): Promise<string> {
  const clientDir = await mkdtemp(join(tmpdir(), 'speckify-client-'));
  const apiDir = join(clientDir, 'api', 'default');
  await mkdir(apiDir, { recursive: true });
  await writeFile(join(apiDir, '__init__.py'), '', 'utf8');
  for (const stem of stems) {
    await writeFile(join(apiDir, `${stem}.py`), '# generated', 'utf8');
  }
  return clientDir;
}

describe('assertClientCompleteness', () => {
  let clientDir: string;

  afterEach(async () => {
    if (clientDir) {
      await rm(clientDir, { recursive: true, force: true });
    }
  });

  it('passes when every operationId has a generated module', async () => {
    clientDir = await makeClientDir(['get_thing', 'create_pet']);
    await expect(
      assertClientCompleteness([operation('getThing'), operation('createPet')], clientDir),
    ).resolves.toBeUndefined();
  });

  it('fails, naming the missing operationId, when a module is absent', async () => {
    // Sabotage: openapi-python-client silently dropped uploadBlob (the
    // known date-time-header limitation) — the guard must catch exactly this.
    clientDir = await makeClientDir(['get_thing']);
    const error = await assertClientCompleteness(
      [operation('getThing'), operation('uploadBlob')],
      clientDir,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CompletenessGuardError);
    expect((error as CompletenessGuardError).missingOperationIds).toEqual(['uploadBlob']);
    expect((error as Error).message).toContain('uploadBlob');
    expect((error as Error).message).toContain('date-time');
  });

  it('fails naming every missing operationId when several are absent', async () => {
    clientDir = await makeClientDir([]);
    const error = await assertClientCompleteness(
      [operation('getThing'), operation('uploadBlob')],
      clientDir,
    ).catch((e: unknown) => e);

    expect((error as CompletenessGuardError).missingOperationIds).toEqual([
      'getThing',
      'uploadBlob',
    ]);
  });

  it('treats a missing api/ directory as every operation missing, not a crash', async () => {
    clientDir = await mkdtemp(join(tmpdir(), 'speckify-client-'));
    const error = await assertClientCompleteness([operation('getThing')], clientDir).catch(
      (e: unknown) => e,
    );
    expect((error as CompletenessGuardError).missingOperationIds).toEqual(['getThing']);
  });
});
