import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { contractNameFromSpecFile, renderSpeckifyConfigYaml } from './config-template.js';

describe('contractNameFromSpecFile', () => {
  it('strips the openapi prefix and extension', () => {
    expect(contractNameFromSpecFile('openapi.yaml')).toBe('api');
    expect(contractNameFromSpecFile('openapi-orders.yaml')).toBe('orders');
    expect(contractNameFromSpecFile('openapi_orders.json')).toBe('orders');
  });

  it('kebab-cases whatever remains', () => {
    expect(contractNameFromSpecFile('Orders_API.yaml')).toBe('orders-api');
  });
});

describe('renderSpeckifyConfigYaml', () => {
  it('produces a config that parses back into the expected shape', () => {
    const yamlText = renderSpeckifyConfigYaml(['openapi.yaml', 'openapi-billing.yaml'], 'Acme');
    const parsed: unknown = parse(yamlText);

    expect(parsed).toEqual({
      contracts: [
        {
          name: 'api',
          spec: 'openapi.yaml',
          typescript: { package: '@acme/api', client: true, server: false },
        },
        {
          name: 'billing',
          spec: 'openapi-billing.yaml',
          typescript: { package: '@acme/billing', client: true, server: false },
        },
      ],
      publish: { githubPackages: { owner: 'Acme' } },
    });
  });
});
