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
 * The `actions/checkout` pin every Speckify workflow in this repo uses
 * (verified against `git ls-remote --tags` — see `scripts/verify-action-pins.mjs`);
 * reused here since the generated workflow needs its own checkout step now
 * that it calls the composite action directly rather than delegating to a
 * reusable workflow that did its own checkout.
 */
const CHECKOUT_PIN = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

/**
 * Renders the producer repo's own caller workflow: a `check` job on every
 * pull request and a `publish` job on push to the default branch, each
 * calling Speckify's composite action directly, pinned to a single ref.
 *
 * This calls the composite action (`uses: <repo>@<ref>`), not Speckify's
 * own reusable workflow (`uses: <repo>/.github/workflows/speckify.yml@<ref>`)
 * — PyPI's trusted-publishing docs are explicit that a reusable workflow
 * cannot be the workflow a Trusted Publisher is configured against: the
 * OIDC token a job invoked via `workflow_call` receives carries
 * `job_workflow_ref` pointing at the *reusable* workflow, not this file, so
 * PyPI's trusted-publisher match (repo + this workflow's own filename)
 * never succeeds. Calling the action directly makes `publish` a job this
 * file genuinely, visibly defines.
 */
export function renderCallerWorkflow(options: RenderCallerWorkflowOptions): string {
  const actionPin = `${options.repo}@${options.ref} # ${options.tag}`;

  return `name: speckify

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout
        uses: ${CHECKOUT_PIN}

      - name: speckify check
        uses: ${actionPin}
        with:
          command: check
          config: ${options.configPath}
        env:
          GITHUB_TOKEN: \${{ github.token }}

  publish:
    if: github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    # PyPI trusted publishing binds an upload to one workflow + this
    # environment name; the environment is also where a required reviewer,
    # if this repo adds one, would gate the actual publish.
    environment: release
    # Never two publishes racing the same registries at once; a second push
    # queues behind the first rather than cancelling it mid-publish.
    concurrency:
      group: speckify-publish
      cancel-in-progress: false
    permissions:
      contents: write
      packages: write
      id-token: write
    steps:
      - name: Checkout
        uses: ${CHECKOUT_PIN}

      - name: speckify publish
        uses: ${actionPin}
        with:
          command: publish
          config: ${options.configPath}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          NODE_AUTH_TOKEN: \${{ github.token }}
`;
}
