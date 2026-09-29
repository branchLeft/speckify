/** The subset of `execFile`'s behaviour the publish runners depend on, so tests can inject a fake. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<{ stdout: string; stderr: string }>;

/** A generated npm package directory, ready for `npm publish`. */
export interface NpmPublishTarget {
  kind: 'npm';
  /** A label for this target in reports, e.g. the contract name. */
  label: string;
  packageDir: string;
  packageName: string;
  version: string;
}

/** A generated Python package's `dist/` directory, holding a wheel and sdist. */
export interface PyPiPublishTarget {
  kind: 'pypi';
  label: string;
  distDir: string;
  packageName: string;
  version: string;
}

export type PublishTarget = NpmPublishTarget | PyPiPublishTarget;

export type TargetOutcomeStatus = 'published' | 'already-published' | 'failed';

export interface TargetOutcome {
  target: PublishTarget;
  status: TargetOutcomeStatus;
  /** Set when `status` is `failed`. */
  error?: string;
}
