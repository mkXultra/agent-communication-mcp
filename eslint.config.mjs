// ESLint flat config (ESLint 9). `npm run lint` lints src/.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // The code written before this config existed injects adapters as `any` throughout and keeps a few
    // unused imports; report the latter without failing the run.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
  {
    // Cloud mode is new code: hold it to the recommended rules.
    files: ['src/cloud/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
