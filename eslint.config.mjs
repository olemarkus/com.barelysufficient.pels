import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import nodePlugin from 'eslint-plugin-n';
import functional from 'eslint-plugin-functional';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      '.homeybuild/**',
      'coverage/**',
      'output/**',
      'playwright-report/**',
      'test-results/**',
      'blob-report/**',
      '.playwright/**',
      '.playwright-cli/**',
      '*.js',
      'settings/*.js',
      'test/screenshots/**',
    ],
  },
  // ESM scripts (Node.js)
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  // Playwright/browser fixtures (run in the browser, but are plain JS files)
  {
    files: ['tests/e2e/fixtures/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  // CommonJS config files
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    plugins: {
      functional,
      n: nodePlugin,
      sonarjs,
      unicorn,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // TypeScript rules
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/consistent-type-definitions': ['warn', 'type'],
      '@typescript-eslint/no-restricted-types': ['warn'],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-require-imports': 'off',

      // General rules
      'no-console': 'off',
      'no-trailing-spaces': 'error',
      'max-len': ['warn', { code: 200 }],
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
      'max-depth': ['warn', 4],
      'max-nested-callbacks': ['warn', 3],
      'max-params': ['warn', 5],
      'max-statements': ['warn', 30],
      'complexity': ['warn', 15],
      'comma-dangle': ['error', 'always-multiline'],
      'operator-linebreak': ['error', 'before'],
      'no-else-return': 'warn',
      'no-implicit-coercion': 'warn',
      'no-multi-assign': 'warn',
      'no-nested-ternary': 'warn',
      'no-param-reassign': ['warn', { props: true }],
      'prefer-const': 'warn',
      'consistent-return': 'warn',

      // SonarJS - code smells and duplication risks
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-duplicated-branches': 'warn',
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-inverted-boolean-check': 'warn',
      'sonarjs/no-redundant-boolean': 'warn',
      'sonarjs/no-small-switch': 'warn',

      // Functional - discourage mutation in calculation-heavy code
      'functional/immutable-data': ['warn', {
        ignoreClasses: true,
        ignoreMapsAndSets: true,
      }],

      // Node rules - allow fetch which is stable in Node 18 (behind --experimental-fetch in older)
      'n/no-unsupported-features/node-builtins': ['error', {
        version: '>=18.0.0',
        ignores: ['fetch'],
      }],
      'n/no-unsupported-features/es-syntax': ['error', { version: '>=18.0.0', ignores: ['modules'] }],
    },
  },
  // Runtime hot paths - stricter perf-oriented iteration rules
  {
    files: ['lib/core/**/*.ts', 'lib/plan/**/*.ts', 'lib/dailyBudget/**/*.ts'],
    rules: {
      // Perf-focused loop refactors may use local mutation; immutability is still enforced elsewhere.
      'functional/immutable-data': 'off',
      'unicorn/no-array-for-each': 'error',
      // TODO(perf): tighten to { allowSimpleOperations: false } after remaining reducers are migrated.
      'unicorn/no-array-reduce': ['error', { allowSimpleOperations: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: ':matches(ForStatement,ForInStatement,ForOfStatement,WhileStatement,DoWhileStatement) CallExpression[callee.object.name="Array"][callee.property.name="from"]',
          message: 'Avoid Array.from allocations inside loops.',
        },
        {
          selector: ':matches(ForStatement,ForInStatement,ForOfStatement,WhileStatement,DoWhileStatement) SpreadElement',
          message: 'Avoid spread allocations inside loops.',
        },
      ],
    },
  },
  // Test files - relaxed rules
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-unsupported-features/es-syntax': 'off',
      'complexity': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      'functional/immutable-data': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-duplicated-branches': 'off',
      'max-len': 'off',
    },
  },
  // Settings UI files - browser environment
  {
    files: ['settings/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        project: './settings/tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-trailing-spaces': 'error',
      'max-len': ['warn', { code: 200 }],
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
      'max-depth': ['warn', 4],
      'max-nested-callbacks': ['warn', 3],
      'max-params': ['warn', 5],
      'max-statements': ['warn', 30],
      'complexity': ['warn', 15],
      'comma-dangle': ['error', 'always-multiline'],
      'no-else-return': 'warn',
      'no-implicit-coercion': 'warn',
      'no-multi-assign': 'warn',
      'no-nested-ternary': 'warn',
      'no-param-reassign': ['warn', { props: true }],
      'prefer-const': 'warn',
      'consistent-return': 'warn',
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-duplicated-branches': 'warn',
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-inverted-boolean-check': 'warn',
      'sonarjs/no-redundant-boolean': 'warn',
      'sonarjs/no-small-switch': 'warn',
      'functional/immutable-data': 'off',
      // Disable Node.js specific rules for browser code
      'n/no-unsupported-features/node-builtins': 'off',
      'n/no-unsupported-features/es-syntax': 'off',
    },
  },
  {
    files: ['app.ts'],
    rules: {
      'max-lines': ['warn', { max: 650, skipBlankLines: true, skipComments: true }],
    },
  },
);
