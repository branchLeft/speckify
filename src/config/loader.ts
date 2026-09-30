import { readFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';

import { ConfigError } from './errors.js';
import { speckifyConfigSchema, type SpeckifyConfig } from './schema.js';

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/**
 * Reads and validates `speckify.yaml` at `configPath`.
 *
 * @throws {ConfigError} if the file cannot be read, is not valid YAML, or
 * fails schema validation. A YAML syntax error carries the line and column
 * the `yaml` parser reports; a schema error carries the field path within
 * the document, since the underlying parser does not preserve per-field
 * source positions once the document is a plain object.
 */
export async function loadConfig(configPath: string): Promise<SpeckifyConfig> {
  const displayPath = isAbsolute(configPath) ? relative(process.cwd(), configPath) : configPath;

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`could not read ${displayPath}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const [line, column] = error.linePos?.[0]
        ? [error.linePos[0].line, error.linePos[0].col]
        : [];
      const position =
        line !== undefined ? ` at line ${String(line)}, column ${String(column)}` : '';
      throw new ConfigError(`${displayPath}${position}: ${error.message}`);
    }
    throw error;
  }

  const result = speckifyConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${formatIssue(issue)}`).join('\n');
    throw new ConfigError(`${displayPath} is invalid:\n${issues}`);
  }

  const names = new Set<string>();
  for (const contract of result.data.contracts) {
    if (names.has(contract.name)) {
      throw new ConfigError(`${displayPath}: duplicate contract name "${contract.name}"`);
    }
    names.add(contract.name);
  }

  return result.data;
}
