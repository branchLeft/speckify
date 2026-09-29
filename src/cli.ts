#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { bundleSpec } from './bundle/index.js';
import { loadConfig, type Contract, type SpeckifyConfig } from './config/index.js';
import { resolveOasdiffBinary } from './oasdiff/index.js';
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
      registryUrl: 'https://npm.pkg.github.com',
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

  const classificationMapPath = resolve(configDir, 'data/oasdiff.classification.json');
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

program
  .command('check')
  .description('Bundle every contract, diff it against the registry, and print the proposed bump.')
  .option('-c, --config <path>', 'path to speckify.yaml', 'speckify.yaml')
  .action(async (options: { config: string }) => {
    const context = await buildPlanContext(options.config);
    for (const contract of context.config.contracts) {
      const plan = await planContract(context, contract);
      const from = plan.previousVersion ?? '(unpublished)';
      console.log(`## ${plan.contract}: ${from} -> ${plan.version} (${plan.bump})\n`);
      console.log(renderChangelogMarkdown(plan.changes));
      if (plan.unknownRuleIds.length > 0) {
        console.log(
          `Unclassified oasdiff rules treated as major: ${plan.unknownRuleIds.join(', ')}\n`,
        );
      }
    }
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

program
  .command('publish')
  .description('Publish generated packages for every contract (not yet implemented).')
  .action(() => {
    notImplemented('publish');
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
