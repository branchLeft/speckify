import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { FetchLike } from '../record/index.js';
import { readAgentSkillTemplate } from './agent-skill-template.js';
import { renderSpeckifyConfigYaml } from './config-template.js';
import { detectOpenapiSpecs } from './detect.js';
import { InitError } from './errors.js';
import { resolveWorkflowRef } from './resolve-workflow-ref.js';
import { renderCallerWorkflow } from './workflow-template.js';

export interface RunInitOptions {
  /** The producer repo's root, where `speckify.yaml` and `.github/` are written. */
  cwd: string;
  /** The GitHub Packages owner this repo will publish generated npm packages under. */
  owner: string;
  /** Speckify's own version, used to resolve the workflow pin. */
  speckifyVersion: string;
  /** `owner/repo` hosting Speckify itself. */
  speckifyRepo: string;
  configPath?: string | undefined;
  force?: boolean | undefined;
  /** Skips writing the `.claude/skills/speckify/SKILL.md` agent skill. */
  noAgentSkill?: boolean | undefined;
  fetchImpl?: FetchLike | undefined;
}

export interface RunInitResult {
  configPath: string;
  workflowPath: string;
  contracts: string[];
  /** Set when the workflow ref fell back to a tag instead of a resolved SHA. */
  warning?: string;
  /** Set to the written path, or `undefined` when skipped or already present. */
  agentSkillPath?: string;
  /** True when an existing agent skill file was kept rather than overwritten. */
  agentSkillKept?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function refuseExisting(path: string, force: boolean): Promise<void> {
  if (!force && (await exists(path))) {
    throw new InitError(`${path} already exists; pass --force to overwrite it`);
  }
}

/**
 * Detects OpenAPI documents in `cwd`, writes a starter `speckify.yaml` for
 * them, and writes the caller workflow that wires this repo into Speckify's
 * reusable workflow. Refuses to overwrite either file unless `force` is set.
 * Also writes `.claude/skills/speckify/SKILL.md`, unless `noAgentSkill` is
 * set -- that file is never overwritten, `force` included: it's meant to be
 * a starting point a repo can go on to edit for itself.
 *
 * @throws {InitError} if no spec is found, or a target file exists without `--force`.
 */
export async function runInit(options: RunInitOptions): Promise<RunInitResult> {
  const specs = await detectOpenapiSpecs(options.cwd);
  if (specs.length === 0) {
    throw new InitError(
      `no OpenAPI document found in ${options.cwd} (looked for openapi*.yaml / openapi*.json)`,
    );
  }

  const configPath = join(options.cwd, options.configPath ?? 'speckify.yaml');
  const workflowPath = join(options.cwd, '.github', 'workflows', 'speckify.yml');
  const force = options.force ?? false;

  await refuseExisting(configPath, force);
  await refuseExisting(workflowPath, force);

  const configYaml = renderSpeckifyConfigYaml(specs, options.owner);
  const resolved = await resolveWorkflowRef({
    version: options.speckifyVersion,
    repo: options.speckifyRepo,
    fetchImpl: options.fetchImpl,
  });
  const workflowYaml = renderCallerWorkflow({
    repo: options.speckifyRepo,
    ref: resolved.ref,
    tag: `v${options.speckifyVersion}`,
    configPath: options.configPath ?? 'speckify.yaml',
  });

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configYaml, 'utf8');
  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, workflowYaml, 'utf8');

  const result: RunInitResult = {
    configPath,
    workflowPath,
    contracts: specs,
  };
  if (resolved.warning !== undefined) {
    result.warning = resolved.warning;
  }

  if (!(options.noAgentSkill ?? false)) {
    const agentSkillPath = join(options.cwd, '.claude', 'skills', 'speckify', 'SKILL.md');
    if (await exists(agentSkillPath)) {
      result.agentSkillKept = true;
    } else {
      const skillMarkdown = await readAgentSkillTemplate();
      await mkdir(dirname(agentSkillPath), { recursive: true });
      await writeFile(agentSkillPath, skillMarkdown, 'utf8');
      result.agentSkillPath = agentSkillPath;
    }
  }

  return result;
}
