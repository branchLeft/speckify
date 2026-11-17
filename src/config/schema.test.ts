import { describe, expect, it } from 'vitest';

import {
  githubRepositorySchema,
  pep503Normalise,
  repositoryDirectorySchema,
  speckifyConfigSchema,
} from './schema.js';

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

describe('githubRepositorySchema', () => {
  it.each(['acme/orders', 'Acme/Orders.v2', 'a_b/c-d', 'acme/.github'])('accepts %j', (value) => {
    expect(githubRepositorySchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '',
    'acme',
    'acme/',
    '/orders',
    'a/b/c',
    'acme/..',
    '../orders',
    'ac me/orders',
    'a/b\n',
  ])('rejects %j', (value) => {
    expect(githubRepositorySchema.safeParse(value).success).toBe(false);
  });
});

describe('repositoryDirectorySchema', () => {
  it.each(['services/broker', 'api', 'packages/a.b/c_d', 'my dir/x'])('accepts %j', (value) => {
    expect(repositoryDirectorySchema.safeParse(value).success).toBe(true);
  });

  it.each(['', '/abs', 'a//b', 'a/', './a', 'a/./b', '../a', 'a/../b', 'a\\b', 'a\nb', 'a\u0000b'])(
    'rejects %j',
    (value) => {
      expect(repositoryDirectorySchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('speckifyConfigSchema', () => {
  it("defaults publish.githubPackages.access to restricted, npm's own default for a scoped package", () => {
    const result = speckifyConfigSchema.parse(validConfig);
    expect(result.publish.githubPackages.access).toBe('restricted');
  });

  it.each(['public', 'restricted'])('accepts publish.githubPackages.access %j', (access) => {
    const result = speckifyConfigSchema.safeParse({
      ...validConfig,
      publish: { githubPackages: { owner: 'acme', access } },
    });
    expect(result.success).toBe(true);
  });

  it.each(['private', 'PUBLIC', '', 1, null])(
    'rejects publish.githubPackages.access %j',
    (access) => {
      const result = speckifyConfigSchema.safeParse({
        ...validConfig,
        publish: { githubPackages: { owner: 'acme', access } },
      });
      expect(result.success).toBe(false);
    },
  );

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

  it('rejects a typescript package scope that does not match publish.githubPackages.owner', () => {
    const result = speckifyConfigSchema.safeParse({
      ...validConfig,
      contracts: [{ ...validConfig.contracts[0], typescript: { package: '@other/orders-api' } }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a typescript package scope matching the owner case-insensitively', () => {
    const result = speckifyConfigSchema.safeParse({
      ...validConfig,
      publish: { githubPackages: { owner: 'ACME' } },
    });
    expect(result.success).toBe(true);
  });

  it('allows a contract with neither typescript nor python targets', () => {
    const result = speckifyConfigSchema.safeParse({
      contracts: [{ name: 'orders-api', spec: './openapi.yaml' }],
      publish: { githubPackages: { owner: 'acme' } },
    });
    expect(result.success).toBe(true);
  });
});
