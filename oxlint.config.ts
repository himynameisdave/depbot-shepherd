import { base, typeAware, vitest } from '@himynameisdave/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [base, vitest, typeAware],
  env: { node: true },
  ignorePatterns: ['dist/**'],
  rules: {
    // This CLI communicates through stdout and GitHub workflow annotations.
    'eslint/no-console': 'off',
    // Tests import Bun's compatible test API instead of Vitest globals.
    'vitest/prefer-importing-vitest-globals': 'off',
    // Helpers are hoisted and grouped by workflow stage for readability.
    'typescript/no-use-before-define': 'off',
  },
});
