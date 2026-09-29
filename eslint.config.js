// @ts-check
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'python/.venv/**', 'python/**/*.py'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // vitest.config.ts is no longer here: it's now covered by
          // tsconfig.json's own `include` (TS-5), so the project service
          // finds it there and rejects a default-project fallback too.
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-throw-literal': 'error',
      'no-empty': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  eslintConfigPrettier,
];
