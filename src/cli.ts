#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { bundleSpec } from './bundle/index.js';
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
import {
  loadClassificationMap,
  loadToolchainImpact,
  toolchainImpact,
  type ClassificationMap,
  type ToolchainImpactEntry,
} from './version/index.js';

/** `owner/repo` hosting Speckify itself — where `init` resolves the reusable workflow's pin. */
const SPECKIFY_REPO = 'speckify/speckify';
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

async function planContract(context: PlanContext, contract: Contract): Promise<ContractPlan> {
  const specPath = resolve(context.configDir, contract.spec);
  const bundledSpec = await bundleSpec(specPath, { repoRoot: context.repoRoot });
  const previous = await resolvePreviousState(contract);

  const impactBump = toolchainImpact(
    context.toolchainImpactEntries,
    previous?.version ?? null,
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

  // The classification map is Speckify's own artifact, shipped with the
  // package (`data/`), not something a consuming repo provides alongside
  // its speckify.yaml.
  const classificationMapPath = resolve(packageRoot, 'data', OASDIFF_CLASSIFICATION_MAP_FILENAME);
  const toolchainImpactPath = resolve(configDir, 'toolchain-impact.json');

  const [classificationMap, toolchainImpactEntries, currentSpeckifyVersion, oasdiffPath] =
    await Promise.all([
      loadClassificationMap(classificationMapPath),
      loadToolchainImpact(toolchainImpactPath),
      readSpeckifyVersion(),
      resolveOasdiffBinary({ cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff') }),
    ]);

  return {
    config,
    configDir,
    repoRoot: configDir,
    classificationMap,
    toolchainImpactEntries,
    currentSpeckifyVersion,
    oasdiffPath,
  };
}

function notImplemented(command: string): never {
  throw new Error(
    `speckify ${command} is not implemented yet: this phase builds the seams codegen and publishing plug into, not those commands themselves.`,
  );
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
 * Where `speckify publish` looks for a contract's generated package, once
 * codegen has produced it — an npm package directory for TypeScript, a
 * `dist/` of wheel + sdist for Python. Both codegen and publish read this
 * same layout; see `docs/configuration.md`.
 */
function targetsForContract(contract: Contract, version: string): PublishTarget[] {
  const targets: PublishTarget[] = [];
  if (contract.typescript?.client === true || contract.typescript?.server === true) {
    targets.push({
      kind: 'npm',
      label: `${contract.name}-typescript`,
      packageDir: join('.speckify', contract.name, 'typescript'),
      packageName: contract.typescript.package,
      version,
    });
  }
  if (contract.python?.client === true || contract.python?.server === true) {
    targets.push({
      kind: 'pypi',
      label: `${contract.name}-python`,
      distDir: join('.speckify', contract.name, 'python', 'dist'),
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
  .description('Publish every contract target whose registry does not already have its version.')
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .action(async (options: { config: string }) => {
    const context = await buildPlanContext(options.config);
    const npmToken = process.env.NODE_AUTH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
    let anyFailed = false;

    for (const contract of context.config.contracts) {
      const plan = await planContract(context, contract);
      const targets = targetsForContract(contract, plan.version);
      if (targets.length === 0) {
        continue;
      }

      const outcomes = await publishContract({
        targets,
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
  .command('codegen')
  .description('Generate client/server packages for every contract (not yet implemented).')
  .action(() => {
    notImplemented('codegen');
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
