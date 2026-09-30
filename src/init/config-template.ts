import { stringify } from 'yaml';

/**
 * Derives a kebab-case contract name from a spec filename: `openapi.yaml` →
 * `api`, `openapi-orders.yaml` → `orders`, `orders.json` → `orders`.
 */
export function contractNameFromSpecFile(fileName: string): string {
  const base = fileName.replace(/\.(ya?ml|json)$/i, '');
  const withoutPrefix = base.replace(/^openapi[-_.]?/i, '');
  const kebab = (withoutPrefix === '' ? 'api' : withoutPrefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return kebab === '' ? 'api' : kebab;
}

/** Renders a starter `speckify.yaml`: one contract per detected spec, npm target scoped to `owner`. */
export function renderSpeckifyConfigYaml(specs: readonly string[], owner: string): string {
  const config = {
    contracts: specs.map((spec) => {
      const name = contractNameFromSpecFile(spec);
      return {
        name,
        spec,
        typescript: { package: `@${owner.toLowerCase()}/${name}`, client: true, server: false },
      };
    }),
    publish: { githubPackages: { owner } },
  };
  return stringify(config);
}
