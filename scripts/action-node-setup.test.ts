import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The composite action runs from whatever workspace a caller checks out, so a
// Node version read from a file under ${{ github.action_path }} is an absolute
// path that actions/setup-node joins onto the caller's workspace. The released
// v0.1.0 failed exactly there. Every setup-node step must name its Node version
// explicitly, and that version must be the one .nvmrc pins for this repo.

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface ActionFile {
  runs: { steps: Step[] };
}

const actionYaml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
const nvmrc = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();

const action = parse(actionYaml) as ActionFile;
const setupNodeSteps = action.runs.steps.filter((step) =>
  step.uses?.startsWith('actions/setup-node@'),
);

describe('composite action Node setup', () => {
  it('has at least one setup-node step to check', () => {
    expect(setupNodeSteps.length).toBeGreaterThan(0);
  });

  it('never reads the Node version file through the action path', () => {
    for (const step of setupNodeSteps) {
      const file = step.with?.['node-version-file'] ?? '';
      expect(file, `step "${step.name ?? 'unnamed'}"`).not.toContain('github.action_path');
    }
  });

  it('gives every setup-node step an explicit version equal to .nvmrc', () => {
    const expected = nvmrc.replace(/^v/, '');
    for (const step of setupNodeSteps) {
      const version = step.with?.['node-version'] ?? '';
      expect(version, `step "${step.name ?? 'unnamed'}"`).toBe(expected);
    }
  });
});
