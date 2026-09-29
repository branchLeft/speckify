import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Without an explicit include, coverage only instruments files a test
      // already imports, so an untested file is absent rather than present
      // at zero — see standards/docs/testing.md, COV-1.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
      reporter: ['text', 'json', 'html'],
    },
  },
});
