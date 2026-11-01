import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // site/ is the pinright.dev website: its own package, lockfile and build, not part of the npm package.
  { ignores: ['dist/**', 'action-dist/**', 'node_modules/**', 'site/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
