import { describe, expect, it } from 'vitest';

import { pep503Normalise, speckifyConfigSchema } from './schema.js';

const validConfig = {
  contracts: [
    {
      name: 'orders-api',
      spec: './openapi.yaml',
      typescript: { package: '@acme/orders-api', client: true, server: false },
      python: { package: 'orders-api', client: true, server: true },
    },
  ],
  publish: { githubPackages: { owner: 'acme' } },
};

describe('pep503Normalise', () => {
  it('lower-cases and collapses separators to a single hyphen', () => {
    expect(pep503Normalise('Orders_API.Client')).toBe('orders-api-client');
    expect(pep503Normalise('already-normal')).toBe('already-normal');
    expect(pep503Normalise('a---b')).toBe('a-b');
  });
});

describe('speckifyConfigSchema', () => {
  it('accepts a well-formed config', () => {
    const result = speckifyConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('defaults client/server to false when omitted', () => {
    const result = speckifyConfigSchema.parse({
      contracts: [
        {
          name: 'orders-api',
          spec: './openapi.yaml',
          typescript: { package: '@acme/orders-api' },
        },
      ],
      publish: { githubPackages: { owner: 'acme' } },
    });
    expect(result.contracts[0]?.typescript?.client).toBe(false);
    expect(result.contracts[0]?.typescript?.server).toBe(false);
  });

  it('rejects a non-kebab-case contract name', () => {
    const result = speckifyConfigSchema.safeParse({
      ...validConfig,
      contracts: [{ ...validConfig.contracts[0], name: 'Orders_API' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty contracts array', () => {
    const result = speckifyConfigSchema.safeParse({ ...validConfig, contracts: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a python package name that is not PEP 503 normalised', () => {
    const result = speckifyConfigSchema.safeParse({
      ...validConfig,
      contracts: [
        {
          ...validConfig.contracts[0],
          python: { package: 'Orders_API', client: true, server: false },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid npm package name', () => {
    const result = speckifyConfigSchema.safeParse({
      ...validConfig,
      contracts: [
        {
          ...validConfig.contracts[0],
          typescript: { package: 'NOT VALID', client: true, server: false },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a config missing publish.githubPackages.owner', () => {
    const result = speckifyConfigSchema.safeParse({
      contracts: validConfig.contracts,
      publish: { githubPackages: { owner: '' } },
    });
    expect(result.success).toBe(false);
  });

  it('allows a contract with neither typescript nor python targets', () => {
    const result = speckifyConfigSchema.safeParse({
      contracts: [{ name: 'orders-api', spec: './openapi.yaml' }],
      publish: { githubPackages: { owner: 'acme' } },
    });
    expect(result.success).toBe(true);
  });
});
