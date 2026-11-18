#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { bundleSpec } from './bundle/index.js';
import { resolveRepoRoot } from './bundle/repo-root.js';
import { renderPrComment, PR_COMMENT_MARKER } from './comment/index.js';
import { loadConfig, type Contract, type SpeckifyConfig } from './config/index.js';
import { createGithubClient, createGithubRelease, createOrUpdateComment } from './github/index.js';
import { runInit } from './init/index.js';
import { OASDIFF_CLASSIFICATION_MAP_FILENAME, resolveOasdiffBinary } from './oasdiff/index.js';
import {
  hasFailures,
  packContract,
  publishContract,
  publishFromPack,
  readPackManifest,
  writePackManifest,
  type PackManifestContract,
  type PublishTarget,
  type TargetOutcome,
  verifyTarballAttestation,
} from './publish/index.js';
import {
  createNpmRegistryRecord,
  createPyPiRegistryRecord,
  reconcileVersions,
  type RegistryRecordEntry,
  type TargetRecord,
} from './record/index.js';
import { computeContractPlan, renderChangelogMarkdown, type ContractPlan } from './plan.js';
import {
  buildContract,
  DEFAULT_BUILD_OUT_DIR,
  type BuildContractOptions,
  type BuildContractResult,
} from './build.js';
import { GITHUB_PACKAGES_REGISTRY, SPECKIFY_REPO } from './constants.js';
import { compareGeneratedSurfaces } from './surface/index.js';
import {
  loadClassificationMap,
  loadToolchainImpact,
  toolchainImpact,
  TOOLCHAIN_IMPACT_FILENAME,
  type ClassificationMap,
  type ToolchainImpactEntry,
} from './version/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readSpeckifyVersion(): Promise<string> {
  const raw = await readFile(join(packageRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
}

/**
 * The repository the generated packages name as their source: the
 * `GITHUB_REPOSITORY` (`owner/repo`) Actions sets on every job. A local run
 * has none, so the packages it builds carry no `repository`; a malformed
 * value is rejected when the package is generated, not guessed at here.
 */
function repositoryFromEnv(): { repository?: string } {
  const repository = process.env.GITHUB_REPOSITORY;
  return repository === undefined || repository === '' ? {} : { repository };
}

async function resolvePreviousState(contract: Contract): Promise<RegistryRecordEntry | null> {
  const targets: TargetRecord[] = [];

  if (contract.typescript !== undefined) {
    const npmRegistry = createNpmRegistryRecord({
      registryUrl: GITHUB_PACKAGES_REGISTRY,
      token: process.env.GITHUB_TOKEN,
    });
    targets.push({
      target: 'typescript',
      entry: await npmRegistry.latest(contract.typescript.package),
    });
  }
  if (contract.python !== undefined) {
    const pypiRegistry = createPyPiRegistryRecord();
    targets.push({ target: 'python', entry: await pypiRegistry.latest(contract.python.package) });
  }

  const { maxVersion } = reconcileVersions(targets);
  if (maxVersion === null) {
    return null;
  }
  const winner = targets.find((target) => target.entry?.version === maxVersion);
  return winner?.entry ?? null;
}

interface PlanContext {
  config: SpeckifyConfig;
  configDir: string;
  repoRoot: string;
  classificationMap: ClassificationMap;
  toolchainImpactEntries: ToolchainImpactEntry[];
  currentSpeckifyVersion: string;
  oasdiffPath: string;
}

/**
 * The bump every consumer inherits from the toolchain moving forward
 * depends on which Speckify version last *generated* the published package
 * (`previous.speckifyVersion`), never the contract's own semver
 * (`previous.version`) -- those are different axes entirely. Exported
 * and pulled out of {@link planContract} so that distinction has its own
 * test, independent of the registry I/O the rest of that function does.
 */
export function resolveToolchainImpactBump(
  previous: RegistryRecordEntry | null,
  toolchainImpactEntries: readonly ToolchainImpactEntry[],
  currentSpeckifyVersion: string,
): ReturnType<typeof toolchainImpact> {
  return toolchainImpact(
    toolchainImpactEntries,
    previous === null ? null : { speckifyVersion: previous.speckifyVersion },
    currentSpeckifyVersion,
  );
}

async function planContract(context: PlanContext, contract: Contract): Promise<ContractPlan> {
  const specPath = resolve(context.configDir, contract.spec);
  const bundledSpec = await bundleSpec(specPath, { repoRoot: context.repoRoot });
  const previous = await resolvePreviousState(contract);

  const impactBump = resolveToolchainImpactBump(
    previous,
    context.toolchainImpactEntries,
    context.currentSpeckifyVersion,
  );

  return computeContractPlan({
    contract: contract.name,
    bundledSpec,
    previous,
    classificationMap: context.classificationMap,
    toolchainImpactBump: impactBump,
    oasdiffPath: context.oasdiffPath,
    surfaceDiff: (previousSpec, currentSpec) =>
      compareGeneratedSurfaces({
        previousSpec,
        currentSpec,
        targets: { typescript: contract.typescript, python: contract.python },
        toolchainDir: join(packageRoot, 'python'),
      }),
  });
}

async function buildPlanContext(configPath: string): Promise<PlanContext> {
  const resolvedConfigPath = resolve(configPath);
  const config = await loadConfig(resolvedConfigPath);
  const configDir = dirname(resolvedConfigPath);

  // The classification map and the toolchain-impact file are both
  // Speckify's own artifacts, shipped with the package (`data/`), not
  // something a consuming repo provides alongside its speckify.yaml.
  const classificationMapPath = resolve(packageRoot, 'data', OASDIFF_CLASSIFICATION_MAP_FILENAME);
  const toolchainImpactPath = resolve(packageRoot, 'data', TOOLCHAIN_IMPACT_FILENAME);

  const [classificationMap, toolchainImpactEntries, currentSpeckifyVersion, oasdiffPath, repoRoot] =
    await Promise.all([
      loadClassificationMap(classificationMapPath),
      loadToolchainImpact(toolchainImpactPath),
      readSpeckifyVersion(),
      resolveOasdiffBinary({ cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff') }),
      resolveRepoRoot(configDir),
    ]);

  return {
    config,
    configDir,
    repoRoot,
    classificationMap,
    toolchainImpactEntries,
    currentSpeckifyVersion,
    oasdiffPath,
  };
}

const program = new Command();
program.name('speckify').description('Bundle, version and publish an OpenAPI contract.');

interface PullRequestEvent {
  number?: number;
}

/**
 * Posts (or updates) the PR comment when running under a `pull_request`
 * workflow with a token to hand: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`
 * (`owner/repo`), `GITHUB_EVENT_NAME=pull_request` and `GITHUB_EVENT_PATH`
 * are the variables Actions sets for every job — the same set `action.yml`
 * passes through. Outside that context (a local run, `push` to `main`)
 * this is a no-op; stdout is always printed regardless.
 */
async function postPrCommentIfInPrContext(plans: readonly ContractPlan[]): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (
    token === undefined ||
    repository === undefined ||
    eventName !== 'pull_request' ||
    eventPath === undefined
  ) {
    return;
  }

  const [owner, repo] = repository.split('/');
  if (owner === undefined || repo === undefined) {
    return;
  }

  try {
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as PullRequestEvent;
    if (typeof event.number !== 'number') {
      return;
    }
    const client = createGithubClient({ token });
    await createOrUpdateComment(
      client,
      { owner, repo, prNumber: event.number },
      PR_COMMENT_MARKER,
      renderPrComment(plans),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`could not post the PR comment: ${reason}`);
  }
}

program
  .command('check')
  .description('Bundle every contract, diff it against the registry, and print the proposed bump.')
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .action(async (options: { config: string }) => {
    const context = await buildPlanContext(options.config);
    const plans: ContractPlan[] = [];
    for (const contract of context.config.contracts) {
      const plan = await planContract(context, contract);
      plans.push(plan);
      const from = plan.previousVersion ?? '(unpublished)';
      console.log(`## ${plan.contract}: ${from} -> ${plan.version} (${plan.bump})\n`);
      console.log(renderChangelogMarkdown(plan.changes));
      if (plan.unknownRuleIds.length > 0) {
        console.log(
          `Unclassified oasdiff rules treated as major: ${plan.unknownRuleIds.join(', ')}\n`,
        );
      }
      for (const change of plan.surface?.changes ?? []) {
        if (change.bump === 'major') {
          console.log(`Surface break (${change.language}) ${change.symbol}: ${change.reason}`);
        }
      }
    }
    await postPrCommentIfInPrContext(plans);
  });

program
  .command('plan')
  .description('Print the proposed bump for every contract as JSON.')
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .option('--json', 'print machine-readable JSON (currently the only supported format)')
  .action(async (options: { config: string; json?: boolean }) => {
    const context = await buildPlanContext(options.config);
    const plans = await Promise.all(
      context.config.contracts.map((contract) => planContract(context, contract)),
    );
    if (options.json !== true) {
      throw new Error('speckify plan currently only supports --json');
    }
    console.log(JSON.stringify(plans, null, 2));
  });

/**
 * Where `speckify publish` looks for a contract's generated package: the
 * directories `buildContract` just built it into, not a path this function
 * guesses independently — `build` and `publish` must never disagree about
 * layout. A target is only produced for a language the config asks to
 * publish (`client`/`server` true), even when `buildContract` generated it
 * for other reasons.
 */
function targetsForContract(
  contract: Contract,
  version: string,
  built: BuildContractResult,
): PublishTarget[] {
  const targets: PublishTarget[] = [];
  if (
    (contract.typescript?.client === true || contract.typescript?.server === true) &&
    built.typescript !== undefined
  ) {
    targets.push({
      kind: 'npm',
      label: `${contract.name}-typescript`,
      packageDir: built.typescript.dir,
      packageName: contract.typescript.package,
      version,
    });
  }
  if (
    (contract.python?.client === true || contract.python?.server === true) &&
    built.python !== undefined
  ) {
    targets.push({
      kind: 'pypi',
      label: `${contract.name}-python`,
      distDir: built.python.distDir,
      packageName: contract.python.package,
      version,
    });
  }
  return targets;
}

/**
 * Best-effort: tags `<contract>@v<version>` and attaches the bundled spec
 * and changelog to a GitHub Release. The registry, not this release, is the
 * record of what got published, so a failure here is a printed warning,
 * never a non-zero exit.
 */
async function createReleaseIfConfigured(
  contract: string,
  published: { version: string; changelog: string; bundledSpec: string },
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (token === undefined || repository === undefined) {
    return;
  }
  const [owner, repo] = repository.split('/');
  if (owner === undefined || repo === undefined) {
    return;
  }

  const client = createGithubClient({ token });
  const tagName = `${contract}@v${published.version}`;
  const result = await createGithubRelease(client, {
    owner,
    repo,
    tagName,
    name: tagName,
    body: published.changelog,
    assets: [
      {
        name: 'openapi.json',
        contentType: 'application/json',
        data: Buffer.from(published.bundledSpec),
      },
    ],
  });
  if (!result.ok) {
    console.warn(result.warning);
  }
}

/** Where `publish --pack-only` writes tarballs and its manifest, relative to the config directory. */
const DEFAULT_PACK_DIR = '.speckify/pack';

/** commander accumulator: each use of a repeatable option adds one value. */
function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface PublishOptions {
  config: string;
  out: string;
  packOnly?: boolean;
  fromPack?: boolean;
  packDir: string;
  attestation: string[];
  requireAttestation?: boolean;
  attestationRepo?: string;
  attestationSignerWorkflow?: string;
  attestationSourceRef?: string;
}

/**
 * The flags that only mean something with `--from-pack`, and the identity
 * flags that only mean something together.
 *
 * @throws {Error} naming the flag at fault.
 */
function assertPublishFlags(options: PublishOptions): void {
  if (options.packOnly === true && options.fromPack === true) {
    throw new Error('--pack-only and --from-pack cannot be used together');
  }
  const identityFlags = [
    ['--attestation-repo', options.attestationRepo],
    ['--attestation-signer-workflow', options.attestationSignerWorkflow],
    ['--attestation-source-ref', options.attestationSourceRef],
  ] as const;
  const fromPackOnly = [
    ['--attestation', options.attestation.length > 0],
    ['--require-attestation', options.requireAttestation === true],
    ...identityFlags.map(([flag, value]) => [flag, value !== undefined] as const),
  ] as const;
  for (const [flag, given] of fromPackOnly) {
    if (given && options.fromPack !== true) {
      throw new Error(`${flag} only applies with --from-pack`);
    }
  }
  const named = identityFlags.filter(([, value]) => value !== undefined);
  if (named.length > 0 && named.length < identityFlags.length) {
    throw new Error(
      '--attestation-repo, --attestation-signer-workflow and --attestation-source-ref must all be given together',
    );
  }
}

/** What every `build` and `publish` run hands `buildContract`, beyond the contract itself. */
function buildOptionsFor(
  context: PlanContext,
  contract: Contract,
  outDir: string,
): BuildContractOptions {
  return {
    contract,
    speckifyVersion: context.currentSpeckifyVersion,
    toolchainDir: join(packageRoot, 'python'),
    outDir,
    repoRoot: context.repoRoot,
    configDir: context.configDir,
    access: context.config.publish.githubPackages.access,
    ...repositoryFromEnv(),
  };
}

function registriesFor(npmToken: string): {
  npm: ReturnType<typeof createNpmRegistryRecord>;
  pypi: ReturnType<typeof createPyPiRegistryRecord>;
} {
  return {
    npm: createNpmRegistryRecord({ registryUrl: GITHUB_PACKAGES_REGISTRY, token: npmToken }),
    pypi: createPyPiRegistryRecord(),
  };
}

/** Prints one line per target, naming `published` as `publishedWord`; true if any failed. */
function printOutcomes(outcomes: readonly TargetOutcome[], publishedWord: string): boolean {
  for (const outcome of outcomes) {
    const status = outcome.status === 'published' ? publishedWord : outcome.status;
    console.log(`${outcome.target.label}: ${status}${outcome.error ? ` (${outcome.error})` : ''}`);
  }
  return hasFailures(outcomes);
}

/**
 * `publish --from-pack`: publishes what `publish --pack-only` packed, each npm
 * package from its tarball exactly as packed. Nothing is rebuilt or re-planned,
 * so the bytes published are the bytes that were packed and, through
 * `--attestation`, the bytes that were attested.
 */
async function publishPacked(options: PublishOptions): Promise<void> {
  const configPath = resolve(options.config);
  const config = await loadConfig(configPath);
  const packDir = resolve(dirname(configPath), options.packDir);
  const manifest = await readPackManifest(packDir);
  const attestationBundles = await Promise.all(
    options.attestation.map((file) => readFile(resolve(file), 'utf8')),
  );
  const npmToken = process.env.NODE_AUTH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

  // All three are given or none (assertPublishFlags), so one check covers them.
  const identity =
    options.attestationRepo === undefined ||
    options.attestationSignerWorkflow === undefined ||
    options.attestationSourceRef === undefined
      ? undefined
      : {
          repo: options.attestationRepo,
          signerWorkflow: options.attestationSignerWorkflow,
          sourceRef: options.attestationSourceRef,
        };

  const results = await publishFromPack({
    packDir,
    manifest,
    registries: registriesFor(npmToken),
    npmRegistryUrl: GITHUB_PACKAGES_REGISTRY,
    npmToken,
    npmOwner: config.publish.githubPackages.owner,
    attestationBundles,
    requireAttestation: options.requireAttestation === true,
    verifyTarball:
      identity === undefined
        ? undefined
        : (tarball): Promise<void> =>
            verifyTarballAttestation({
              tarballPath: tarball.tarballPath,
              sha256: tarball.sha256,
              identity,
            }),
  });

  let anyFailed = false;
  for (const result of results) {
    if (printOutcomes(result.outcomes, 'published')) {
      anyFailed = true;
    }
    if (result.outcomes.some((outcome) => outcome.status === 'published')) {
      await createReleaseIfConfigured(result.name, result);
    }
  }
  if (anyFailed) {
    process.exitCode = 1;
  }
}

program
  .command('publish')
  .description(
    'Plan, build and publish every contract target whose registry does not already have its version.',
  )
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .option('-o, --out <dir>', 'build output directory', DEFAULT_BUILD_OUT_DIR)
  .option(
    '--pack-only',
    'build and pack every unpublished npm package into --pack-dir, writing a manifest and printing each tarball; publish nothing',
  )
  .option(
    '--from-pack',
    'publish what --pack-only packed in --pack-dir: each tarball exactly as packed, after checking its digest',
  )
  .option(
    '--pack-dir <dir>',
    'where --pack-only writes and --from-pack reads, relative to the config directory',
    DEFAULT_PACK_DIR,
  )
  .option(
    '--attestation <file>',
    'with --from-pack: an attestation bundle file; publish only if every tarball digest is one of its subjects (repeatable)',
    collectOption,
    [] as string[],
  )
  .option(
    '--require-attestation',
    'with --from-pack: refuse to publish any npm tarball unless an --attestation was given',
  )
  .option(
    '--attestation-repo <owner/repo>',
    'with --from-pack: verify each tarball`s attestation signature (gh attestation verify) as made in this repository',
  )
  .option(
    '--attestation-signer-workflow <path>',
    'with --from-pack: the workflow that must have signed, owner/repo/.github/workflows/<file>.yml',
  )
  .option(
    '--attestation-source-ref <ref>',
    'with --from-pack: the exact ref the signing run must have been on, e.g. refs/heads/main',
  )
  .action(async (options: PublishOptions) => {
    assertPublishFlags(options);
    if (options.fromPack === true) {
      await publishPacked(options);
      return;
    }

    const context = await buildPlanContext(options.config);
    const npmToken = process.env.NODE_AUTH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
    const packDir = resolve(context.configDir, options.packDir);
    const packed: PackManifestContract[] = [];
    // Resolved once, against the config dir, rather than left relative:
    // `uv build` runs with its cwd set to the generated project dir (itself
    // nested under this directory), so a relative --out-dir get resolved a
    // second time against *that* cwd and lands doubly nested underneath
    // itself instead of where Speckify looks for the wheel and sdist.
    const outDir = resolve(context.configDir, options.out);
    let anyFailed = false;

    for (const contract of context.config.contracts) {
      const plan = await planContract(context, contract);
      const built = await buildContract(plan, buildOptionsFor(context, contract, outDir));
      const targets = targetsForContract(contract, plan.version, built);
      if (targets.length === 0) {
        continue;
      }
      const registries = registriesFor(npmToken);
      const npmOwner = context.config.publish.githubPackages.owner;

      if (options.packOnly === true) {
        const result = await packContract({
          contract: contract.name,
          version: plan.version,
          changelog: renderChangelogMarkdown(plan.changes),
          bundledSpec: plan.bundledSpec,
          targets,
          packDir,
          registries,
          npmOwner,
        });
        packed.push(result.contract);
        if (printOutcomes(result.outcomes, 'packed')) {
          anyFailed = true;
        }
        continue;
      }

      const outcomes = await publishContract({
        targets,
        builtBundledSpec: plan.bundledSpec,
        registries,
        npmRegistryUrl: GITHUB_PACKAGES_REGISTRY,
        npmToken,
        npmOwner,
      });
      if (printOutcomes(outcomes, 'published')) {
        anyFailed = true;
      }
      if (outcomes.some((outcome) => outcome.status === 'published')) {
        await createReleaseIfConfigured(contract.name, {
          version: plan.version,
          changelog: renderChangelogMarkdown(plan.changes),
          bundledSpec: plan.bundledSpec,
        });
      }
    }

    if (options.packOnly === true) {
      const manifestPath = await writePackManifest(packDir, {
        schemaVersion: 1,
        contracts: packed,
      });
      console.log(`manifest: ${manifestPath}`);
      for (const contract of packed) {
        for (const target of contract.targets) {
          if (target.kind === 'npm') {
            console.log(`tarball: ${join(packDir, target.tarball)} sha256:${target.sha256}`);
          }
        }
      }
    }

    if (anyFailed) {
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Detect an OpenAPI document and write a starter speckify.yaml and CI workflow.')
  .requiredOption(
    '--owner <owner>',
    'the GitHub Packages owner (org or user) generated npm packages publish under',
  )
  .option('-c, --config <path>', 'path to write speckify.yaml', 'speckify.yaml')
  .option('--force', 'overwrite an existing speckify.yaml or workflow file')
  .option(
    '--no-agent-skill',
    'skip writing .claude/skills/speckify/SKILL.md, the coding-agent skill for this contract',
  )
  .action(
    async (options: { owner: string; config: string; force?: boolean; agentSkill: boolean }) => {
      const speckifyVersion = await readSpeckifyVersion();
      const result = await runInit({
        cwd: process.cwd(),
        owner: options.owner,
        speckifyVersion,
        speckifyRepo: SPECKIFY_REPO,
        configPath: options.config,
        force: options.force,
        noAgentSkill: !options.agentSkill,
      });
      console.log(`Wrote ${result.configPath}`);
      console.log(`Wrote ${result.workflowPath}`);
      if (result.agentSkillPath !== undefined) {
        console.log(`Wrote ${result.agentSkillPath}`);
      } else if (result.agentSkillKept === true) {
        console.log('Kept the existing .claude/skills/speckify/SKILL.md');
      }
      if (result.warning !== undefined) {
        console.warn(result.warning);
      }
    },
  );

program
  .command('build')
  .description(
    'Plan every contract, then generate and build its client/server packages into --out.',
  )
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .option('-o, --out <dir>', 'output directory', DEFAULT_BUILD_OUT_DIR)
  .action(async (options: { config: string; out: string }) => {
    const context = await buildPlanContext(options.config);
    // See the `publish` command's identical resolve: an unresolved relative
    // --out-dir gets re-resolved against `uv build`'s own cwd and lands
    // nested underneath itself.
    const outDir = resolve(context.configDir, options.out);
    for (const contract of context.config.contracts) {
      const plan = await planContract(context, contract);
      const result = await buildContract(plan, buildOptionsFor(context, contract, outDir));
      const from = plan.previousVersion ?? '(unpublished)';
      console.log(`## ${plan.contract}: ${from} -> ${plan.version} (${plan.bump})`);
      if (result.typescript) console.log(`  typescript: ${result.typescript.dir}`);
      if (result.python) console.log(`  python: ${result.python.distDir}`);
    }
  });

/**
 * Reads one dotted-path value (e.g., "publish.githubPackages.owner") from
 * an already-validated config object. Returns string or undefined if the
 * path does not resolve to a string. See cli.md for details.
 * @returns the value at `path`, or `undefined` if any segment is not a plain
 * object (except the last) or the final value is not a string.
 */
export function getConfigStringValue(config: SpeckifyConfig, path: string): string | undefined {
  let current: unknown = config;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

const configCommand = program.command('config').description('Inspect a speckify.yaml value.');

configCommand
  .command('get')
  .description(
    'Print one dotted-path value from speckify.yaml (e.g. publish.githubPackages.owner). ' +
      'Exits non-zero, printing nothing, if the path is unset or not a string.',
  )
  .argument('<path>', 'dotted path into the loaded config, e.g. publish.githubPackages.owner')
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .action(async (path: string, options: { config: string }) => {
    const config = await loadConfig(resolve(options.config));
    const value = getConfigStringValue(config, path);
    if (value === undefined) {
      console.error(`speckify.yaml has no string value at "${path}"`);
      process.exitCode = 1;
      return;
    }
    console.log(value);
  });

// Guard allows imports (e.g., resolveToolchainImpactBump in tests) without
// parsing argv. npm bin symlink paths need realpath on both sides to match.
// See cli.md for why comparing raw argv[1] fails.
async function isRunningAsMain(): Promise<boolean> {
  const argvPath = process.argv[1];
  if (argvPath === undefined) {
    return false;
  }
  const invokedPath = await realpath(argvPath).catch(() => argvPath);
  return import.meta.url === pathToFileURL(invokedPath).href;
}

if (await isRunningAsMain()) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
