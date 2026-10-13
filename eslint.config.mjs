// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.d.ts'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['info', 'warn', 'error'] }]
    }
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // Test-file `any` is concentrated at harness/DTO seams (scripted pools,
    // Fastify inject bodies, pg row casts). Turning the rule off here is
    // narrower than ignoring tests or disabling it globally: unused-vars,
    // prefer-const, no-empty, and type-import rules still apply to tests.
    // Production source keeps `@typescript-eslint/no-explicit-any`.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/support/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // Plain-JS scripts (DB bootstrap, Next config) run under Node.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        __dirname: 'readonly'
      }
    }
  }
);
