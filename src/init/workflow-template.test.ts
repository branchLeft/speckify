import { describe, expect, it } from 'vitest';

import { renderCallerWorkflow } from './workflow-template.js';

// PyPI trusted publishing does not accept a reusable workflow as the
// Trusted Publisher's own workflow -- the producer's OIDC token carries
// `job_workflow_ref` pointing at the *reusable* workflow it was invoked
// through, not the caller's own file, which is what PyPI's Trusted
// Publisher configuration names. The generated caller workflow now calls
// Speckify's composite action directly (`uses: <repo>@<sha>`), so the job
// that runs `uv publish --trusted-publishing` is a job the caller's own
// workflow file genuinely defines.
describe('renderCallerWorkflow', () => {
  const yamlText = renderCallerWorkflow({
    repo: 'branchLeft/speckify',
    ref: 'a'.repeat(40),
    tag: 'v1.2.0',
    configPath: 'speckify.yaml',
  });

  it('calls the composite action directly, pinned to the resolved SHA with the tag as a trailing comment', () => {
    expect(yamlText).toContain(`uses: branchLeft/speckify@${'a'.repeat(40)} # v1.2.0`);
    // Never the reusable workflow: that's exactly the shape PyPI can't
    // trust-publish through.
    expect(yamlText).not.toContain('.github/workflows/speckify.yml');
  });

  it('never uses secrets: inherit (meaningless for a composite-action step, and no longer needed)', () => {
    expect(yamlText).not.toContain('secrets: inherit');
  });

  it('has a check job gated on pull_request and a publish job gated on push to main', () => {
    expect(yamlText).toMatch(/check:\s*\n\s*if: github\.event_name == 'pull_request'/);
    expect(yamlText).toMatch(
      /publish:\s*\n\s*if: github\.event_name == 'push' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
    );
  });

  it('writes the ref the attestation must come from as a literal, never as an expression of the run', () => {
    const publishJob = yamlText.slice(yamlText.indexOf('publish:'));
    expect(publishJob).toMatch(/^ {10}attestation-source-ref: refs\/heads\/main$/m);
    expect(publishJob).not.toMatch(/^ {10}attestation-[a-z-]+: .*\$\{\{/m);
  });

  it('tells the consumer to write the repository and signer workflow as literals too', () => {
    expect(yamlText).toContain('# attestation-repo: OWNER/REPO');
    expect(yamlText).toContain('# attestation-signer-workflow: OWNER/REPO/.github/workflows/');
  });

  it('runs the publish job under the release environment with a non-cancelling concurrency group', () => {
    const publishJob = yamlText.slice(yamlText.indexOf('publish:'));
    expect(publishJob).toContain('environment: release');
    expect(publishJob).toContain('group: speckify-publish');
    expect(publishJob).toContain('cancel-in-progress: false');
  });

  // The action attests the packed tarballs before publishing them (its
  // `attest` input defaults on), which needs `id-token: write` to sign and
  // `attestations: write` to store the attestation.
  it('gives the publish job exactly contents, packages, id-token and attestations write', () => {
    const publishJob = yamlText.slice(yamlText.indexOf('publish:'));
    const permissionsBlock = /permissions:\n((?:\s+\S+: \S+\n?)+)/.exec(publishJob);
    expect(permissionsBlock).not.toBeNull();
    const permissions = permissionsBlock?.[1] ?? '';
    expect(permissions).toContain('contents: write');
    expect(permissions).toContain('packages: write');
    expect(permissions).toContain('id-token: write');
    expect(permissions).toContain('attestations: write');
    expect(permissions).not.toContain('pull-requests');
  });

  it('passes the config path and github.token through explicitly, per job', () => {
    expect(yamlText).toContain('config: speckify.yaml');
    expect(yamlText).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(yamlText).toContain('NODE_AUTH_TOKEN: ${{ github.token }}');
  });

  it('checks the caller repository out itself before invoking the action', () => {
    expect(yamlText).toContain('uses: actions/checkout@');
  });
});
