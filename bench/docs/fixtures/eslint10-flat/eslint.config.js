import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/']),
  { files: ['**/*.ts'], extends: [js.configs.recommended, tseslint.configs.recommended], rules: { 'no-console': 'warn' } },
  { files: ['scripts/**'], rules: { 'no-console': 'off' } },
);
