#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
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
import { hasFailures, publishContract, type PublishTarget } from './publish/index.js';
import {
  createNpmRegistryRecord,
  createPyPiRegistryRecord,
  reconcileVersions,
  type RegistryRecordEntry,
  type TargetRecord,
} from './record/index.js';
import { computeContractPlan, renderChangelogMarkdown, type ContractPlan } from './plan.js';
import { buildContract, DEFAULT_BUILD_OUT_DIR, type BuildContractResult } from './build.js';
import { SPECKIFY_REPO } from './constants.js';
import {
  loadClassificationMap,
  loadToolchainImpact,
  toolchainImpact,
  TOOLCHAIN_IMPACT_FILENAME,
  type ClassificationMap,
  type ToolchainImpactEntry,
} from './version/index.js';

const GITHUB_PACKAGES_REGISTRY = 'https://npm.pkg.github.com';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readSpeckifyVersion(): Promise<string> {
  const raw = await readFile(join(packageRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { version: string };
  return pkg.version;
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
async function createReleaseIfConfigured(contract: string, plan: ContractPlan): Promise<void> {
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
  const tagName = `${contract}@v${plan.version}`;
  const result = await createGithubRelease(client, {
    owner,
    repo,
    tagName,
    name: tagName,
    body: renderChangelogMarkdown(plan.changes),
    assets: [
      {
        name: 'openapi.json',
        contentType: 'application/json',
        data: Buffer.from(plan.bundledSpec),
      },
    ],
  });
  if (!result.ok) {
    console.warn(result.warning);
  }
}

program
  .command('publish')
  .description(
    'Plan, build and publish every contract target whose registry does not already have its version.',
  )
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .option('-o, --out <dir>', 'build output directory', DEFAULT_BUILD_OUT_DIR)
  .action(async (options: { config: string; out: string }) => {
    const context = await buildPlanContext(options.config);
    const npmToken = process.env.NODE_AUTH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
    // Resolved once, against the config dir, rather than left relative:
    // `uv build` runs with its cwd set to the generated project dir (itself
    // nested under this directory), so a relative --out-dir get resolved a
    // second time against *that* cwd and lands doubly nested underneath
    // itself instead of where Speckify looks for the wheel and sdist.
    const outDir = resolve(context.configDir, options.out);
    let anyFailed = false;

    for (const contract of context.config.contracts) {
      const plan = await planContract(context, contract);
      const built = await buildContract(plan, {
        contract,
        speckifyVersion: context.currentSpeckifyVersion,
        toolchainDir: join(packageRoot, 'python'),
        outDir,
      });
      const targets = targetsForContract(contract, plan.version, built);
      if (targets.length === 0) {
        continue;
      }

      const outcomes = await publishContract({
        targets,
        builtBundledSpec: plan.bundledSpec,
        registries: {
          npm:
            contract.typescript !== undefined
              ? createNpmRegistryRecord({ registryUrl: GITHUB_PACKAGES_REGISTRY, token: npmToken })
              : undefined,
          pypi: contract.python !== undefined ? createPyPiRegistryRecord() : undefined,
        },
        npmRegistryUrl: GITHUB_PACKAGES_REGISTRY,
        npmToken,
        npmOwner: context.config.publish.githubPackages.owner,
      });

      let contractPublished = false;
      for (const outcome of outcomes) {
        console.log(
          `${outcome.target.label}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`,
        );
        if (outcome.status === 'published') {
          contractPublished = true;
        }
      }
      if (hasFailures(outcomes)) {
        anyFailed = true;
      }
      if (contractPublished) {
        await createReleaseIfConfigured(contract.name, plan);
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
  .action(async (options: { owner: string; config: string; force?: boolean }) => {
    const speckifyVersion = await readSpeckifyVersion();
    const result = await runInit({
      cwd: process.cwd(),
      owner: options.owner,
      speckifyVersion,
      speckifyRepo: SPECKIFY_REPO,
      configPath: options.config,
      force: options.force,
    });
    console.log(`Wrote ${result.configPath}`);
    console.log(`Wrote ${result.workflowPath}`);
    if (result.warning !== undefined) {
      console.warn(result.warning);
    }
  });

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
      const result = await buildContract(plan, {
        contract,
        speckifyVersion: context.currentSpeckifyVersion,
        toolchainDir: join(packageRoot, 'python'),
        outDir,
      });
      const from = plan.previousVersion ?? '(unpublished)';
      console.log(`## ${plan.contract}: ${from} -> ${plan.version} (${plan.bump})`);
      if (result.typescript) console.log(`  typescript: ${result.typescript.dir}`);
      if (result.python) console.log(`  python: ${result.python.distDir}`);
    }
  });

// Guarded so this file can be imported (e.g. `resolveToolchainImpactBump`
// from a unit test) without also parsing the importing process's own argv
// as a speckify invocation.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
