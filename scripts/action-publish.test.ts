import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The composite action is the producer's whole publish path, so its inputs
// and the order of its steps are behaviour, not decoration: `command` takes
// exactly check, plan, build and publish; a publish packs the npm packages,
// attests those tarballs, then publishes the same files, refusing any whose
// digest is not in the attestation. The `run:` scripts are executed here
// against a stub CLI that records its arguments, rather than read as text.

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  shell?: string;
  run?: string;
}

interface ActionFile {
  inputs: Record<string, { description: string; required?: boolean; default?: string }>;
  runs: { steps: Step[] };
}

const action = parse(
  await readFile(new URL('../action.yml', import.meta.url), 'utf8'),
) as ActionFile;

const steps = action.runs.steps;

function step(id: string): Step {
  const found = steps.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`action.yml has no step with id "${id}"`);
  }
  return found;
}

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a step's script the way Actions runs `shell: bash`: `bash -e -o pipefail`. */
async function runScript(
  script: string,
  env: Record<string, string>,
  cwd?: string,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      ...(cwd === undefined ? {} : { cwd }),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** An action directory whose `dist/cli.js` writes its arguments, one JSON line, to `calls.jsonl` and, for --pack-only, a tarball. */
async function stubAction(options: {
  packs: boolean;
}): Promise<{ dir: string; calls: () => Promise<string[][]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'speckify-action-stub-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(
    join(dir, 'dist', 'cli.js'),
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify(args) + '\\n');`,
      `if (${String(options.packs)} && args.includes('--pack-only')) {`,
      "  const packDir = args[args.indexOf('--pack-dir') + 1];",
      '  mkdirSync(packDir, { recursive: true });',
      "  writeFileSync(join(packDir, 'acme-orders-1.0.0.tgz'), 'tarball');",
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  return {
    dir,
    calls: async () =>
      (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]),
  };
}

describe('the command and attest inputs', () => {
  it('documents every command the action accepts', () => {
    const description = action.inputs.command?.description ?? '';
    for (const command of ['check', 'plan', 'build', 'publish']) {
      expect(description, command).toContain(`"${command}"`);
    }
  });

  it('attests by default, as a string the workflow expressions compare', () => {
    expect(action.inputs.attest?.default).toBe('true');
    expect(action.inputs.attest?.required).toBe(false);
  });

  it('checks its inputs before it installs anything', () => {
    expect(steps[0]?.id).toBe('inputs');
  });

  it.each(['check', 'plan', 'build', 'publish'])('accepts the command %s', async (command) => {
    for (const attest of ['true', 'false']) {
      const result = await runScript(step('inputs').run ?? '', {
        SPECKIFY_COMMAND: command,
        SPECKIFY_ATTEST: attest,
      });
      expect(result.code, `${command} attest=${attest}: ${result.stderr}`).toBe(0);
    }
  });

  it.each(['', 'Check', 'publish ', 'init', 'config', 'publish --from-pack', 'check; id'])(
    'refuses the command %j, and says what is accepted',
    async (command) => {
      const result = await runScript(step('inputs').run ?? '', {
        SPECKIFY_COMMAND: command,
        SPECKIFY_ATTEST: 'true',
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('check, plan, build, publish');
    },
  );

  it.each(['', 'yes', 'TRUE', '1'])('refuses attest %j', async (attest) => {
    const result = await runScript(step('inputs').run ?? '', {
      SPECKIFY_COMMAND: 'publish',
      SPECKIFY_ATTEST: attest,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('attest must be true or false');
  });

  it('reads both inputs through the environment, never interpolated into the script', () => {
    for (const candidate of steps) {
      expect(candidate.run ?? '', candidate.name).not.toContain('${{');
    }
    expect(step('inputs').env).toEqual({
      SPECKIFY_COMMAND: '${{ inputs.command }}',
      SPECKIFY_ATTEST: '${{ inputs.attest }}',
    });
  });
});

describe('the Run Speckify step', () => {
  const runStep = step('run');

  it.each([
    ['check', ['check', '--config', 'speckify.yaml']],
    ['build', ['build', '--config', 'speckify.yaml']],
    ['plan', ['plan', '--config', 'speckify.yaml', '--json']],
    ['publish', ['publish', '--config', 'speckify.yaml']],
  ])('runs %s with exactly the arguments the command needs', async (command, expected) => {
    const stub = await stubAction({ packs: false });
    const result = await runScript(runStep.run ?? '', {
      SPECKIFY_ACTION_PATH: stub.dir,
      SPECKIFY_COMMAND: command,
      SPECKIFY_CONFIG: 'speckify.yaml',
    });
    expect(result.code, result.stderr).toBe(0);
    expect(await stub.calls()).toEqual([expected]);
  });

  it('is skipped only for a publish that attests, which the pack, attest and publish steps carry', () => {
    expect(runStep.if).toBe("inputs.command != 'publish' || inputs.attest != 'true'");
    for (const id of ['pack', 'publish-packed']) {
      expect(step(id).if).toBe("inputs.command == 'publish' && inputs.attest == 'true'");
    }
  });
});

describe('the pack step', () => {
  const packStep = step('pack');

  it('packs into a directory of its own under the runner temp, and reports it and whether any tarball was written', async () => {
    const stub = await stubAction({ packs: true });
    const temp = await mkdtemp(join(tmpdir(), 'speckify-action-temp-'));
    tempDirs.push(temp);
    const outputFile = join(temp, 'output');
    await writeFile(outputFile, '');

    const result = await runScript(packStep.run ?? '', {
      SPECKIFY_ACTION_PATH: stub.dir,
      SPECKIFY_CONFIG: 'speckify.yaml',
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: outputFile,
    });

    expect(result.code, result.stderr).toBe(0);
    const packDir = join(temp, 'speckify-pack');
    expect(await stub.calls()).toEqual([
      ['publish', '--config', 'speckify.yaml', '--pack-only', '--pack-dir', packDir],
    ]);
    expect(await readFile(outputFile, 'utf8')).toBe(`pack-dir=${packDir}\nhas-tarballs=true\n`);
  });

  it('reports no tarballs when everything is already published, so nothing is attested', async () => {
    const stub = await stubAction({ packs: false });
    const temp = await mkdtemp(join(tmpdir(), 'speckify-action-temp-'));
    tempDirs.push(temp);
    const outputFile = join(temp, 'output');
    await writeFile(outputFile, '');

    const result = await runScript(packStep.run ?? '', {
      SPECKIFY_ACTION_PATH: stub.dir,
      SPECKIFY_CONFIG: 'speckify.yaml',
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: outputFile,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(outputFile, 'utf8')).toContain('has-tarballs=false');
  });

  it('fails when the pack run fails', async () => {
    const result = await runScript(packStep.run ?? '', {
      SPECKIFY_ACTION_PATH: '/nonexistent',
      SPECKIFY_CONFIG: 'speckify.yaml',
      RUNNER_TEMP: tmpdir(),
      GITHUB_OUTPUT: '/dev/null',
    });
    expect(result.code).not.toBe(0);
  });
});

describe('the attest step', () => {
  const attestStep = step('attest');

  it('uses actions/attest-build-provenance, pinned by a full commit SHA', () => {
    expect(attestStep.uses).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
  });

  it('attests every tarball the pack step wrote, and only when it wrote any', () => {
    expect(attestStep.if).toBe("steps.pack.outputs.has-tarballs == 'true'");
    expect(attestStep.with?.['subject-path']).toBe('${{ steps.pack.outputs.pack-dir }}/*.tgz');
  });

  it('asks for no storage record, which needs a permission the caller does not hold', () => {
    expect(attestStep.with?.['create-storage-record']).toBe(false);
  });
});

describe('the publish-packed step', () => {
  const publishStep = step('publish-packed');

  function inputsOf(attestation: string, hasTarballs: string): Record<string, string> {
    return {
      SPECKIFY_CONFIG: 'speckify.yaml',
      SPECKIFY_PACK_DIR: '/packs',
      SPECKIFY_ATTESTATION: attestation,
      SPECKIFY_HAS_TARBALLS: hasTarballs,
    };
  }

  it('hands the attestation bundle to the publish, so the digests are checked against it', async () => {
    const stub = await stubAction({ packs: false });
    const result = await runScript(publishStep.run ?? '', {
      ...inputsOf('/tmp/attestation.jsonl', 'true'),
      SPECKIFY_ACTION_PATH: stub.dir,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(await stub.calls()).toEqual([
      [
        'publish',
        '--config',
        'speckify.yaml',
        '--from-pack',
        '--pack-dir',
        '/packs',
        '--attestation',
        '/tmp/attestation.jsonl',
      ],
    ]);
  });

  it('publishes without an attestation only when no tarball was packed', async () => {
    const stub = await stubAction({ packs: false });
    const result = await runScript(publishStep.run ?? '', {
      ...inputsOf('', 'false'),
      SPECKIFY_ACTION_PATH: stub.dir,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(await stub.calls()).toEqual([
      ['publish', '--config', 'speckify.yaml', '--from-pack', '--pack-dir', '/packs'],
    ]);
  });

  it('refuses to publish tarballs the attest step left no attestation for', async () => {
    const stub = await stubAction({ packs: false });
    const result = await runScript(publishStep.run ?? '', {
      ...inputsOf('', 'true'),
      SPECKIFY_ACTION_PATH: stub.dir,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('no attestation');
    expect(await stub.calls()).toEqual([]);
  });

  it('reads the pack directory, tarball flag and bundle path from the earlier steps', () => {
    expect(publishStep.env).toMatchObject({
      SPECKIFY_PACK_DIR: '${{ steps.pack.outputs.pack-dir }}',
      SPECKIFY_HAS_TARBALLS: '${{ steps.pack.outputs.has-tarballs }}',
      SPECKIFY_ATTESTATION: '${{ steps.attest.outputs.bundle-path }}',
    });
  });
});

describe('the order of the publish steps', () => {
  it('packs, then attests, then publishes, after the registry auth that publishing needs', () => {
    const ids = steps.map((candidate) => candidate.id);
    const position = (id: string): number => ids.indexOf(id);
    expect(position('pack')).toBeGreaterThan(position('npm-owner'));
    expect(position('attest')).toBeGreaterThan(position('pack'));
    expect(position('publish-packed')).toBeGreaterThan(position('attest'));
  });

  it('sets up registry auth before any of them', () => {
    const authIndex = steps.findIndex((candidate) =>
      candidate.name?.startsWith('Set up GitHub Packages auth'),
    );
    expect(authIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeLessThan(steps.findIndex((candidate) => candidate.id === 'pack'));
    expect(authIndex).toBeLessThan(steps.findIndex((candidate) => candidate.id === 'run'));
  });
});
