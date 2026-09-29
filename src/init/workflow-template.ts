export interface RenderCallerWorkflowOptions {
  /** `owner/repo` hosting Speckify itself. */
  repo: string;
  /** A commit SHA, or a tag if SHA resolution fell back. */
  ref: string;
  /** The Speckify release this pin corresponds to, e.g. `v1.4.0` — recorded in a comment either way. */
  tag: string;
  configPath: string;
}

/**
 * Renders the producer repo's own caller workflow: a `check` gate on every
 * pull request and a `publish` gate on push to `main`, both delegated to
 * Speckify's reusable workflow pinned to a single ref.
 */
export function renderCallerWorkflow(options: RenderCallerWorkflowOptions): string {
  return `name: speckify

on:
  pull_request:
  push:
    branches: [main]

jobs:
  speckify:
    uses: ${options.repo}/.github/workflows/speckify.yml@${options.ref} # ${options.tag}
    with:
      config: ${options.configPath}
      # Passed explicitly, not read back from the workflow's own context:
      # github.job_workflow_sha is not reliably populated inside a called
      # reusable workflow, so the exact ref the composite action itself
      # runs at has to come from the caller that already resolved it.
      ref: ${options.ref}
    permissions:
      contents: write
      pull-requests: write
      packages: write
      id-token: write
    secrets: inherit
`;
}
