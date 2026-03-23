import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import nodePlugin from 'eslint-plugin-n';
import functional from 'eslint-plugin-functional';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';

const sharedTypeScriptRules = {
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
};

const sharedGeneralRules = {
  'no-console': 'off',
  'no-trailing-spaces': 'error',
  'max-len': ['warn', { code: 120 }],
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
};

const sharedSonarRules = {
  'sonarjs/cognitive-complexity': ['warn', 15],
  'sonarjs/no-duplicated-branches': 'warn',
  'sonarjs/no-identical-functions': 'warn',
  'sonarjs/no-inverted-boolean-check': 'warn',
  'sonarjs/no-redundant-boolean': 'warn',
  'sonarjs/no-small-switch': 'warn',
};

const nodeTypeScriptRules = {
  ...sharedTypeScriptRules,
  ...sharedGeneralRules,
  ...sharedSonarRules,
  'functional/immutable-data': ['warn', {
    ignoreClasses: true,
    ignoreMapsAndSets: true,
  }],
  'n/no-unsupported-features/node-builtins': ['error', {
    version: '>=18.0.0',
    ignores: ['fetch'],
  }],
  'n/no-unsupported-features/es-syntax': ['error', { version: '>=18.0.0', ignores: ['modules'] }],
};

const browserTypeScriptRules = {
  ...sharedTypeScriptRules,
  ...sharedGeneralRules,
  ...sharedSonarRules,
  'functional/immutable-data': 'off',
  'n/no-unsupported-features/node-builtins': 'off',
  'n/no-unsupported-features/es-syntax': 'off',
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      '.claude/**',
      '.homeybuild/**',
      'coverage/**',
      'output/**',
      'playwright-report/**',
      'test-results/**',
      'blob-report/**',
      'tmp/**',
      '.playwright/**',
      '.playwright-cli/**',
      '.playwright-mcp/**',
      'docs/.vitepress/.temp/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/cache/**',
      'packages/settings-ui/dist/**',
      'packages/settings-ui/playwright-report/**',
      'packages/settings-ui/test-results/**',
      'packages/settings-ui/blob-report/**',
      '*.js',
      'settings/*.js',
      'widgets/**/*.js',
      'test/screenshots/**',
      'packages/settings-ui/test/screenshots/**',
      'echarts-modules.d.ts',
      'playwright.config.ts',
      'tmp/**',
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
  {
    files: ['packages/settings-ui/tests/e2e/fixtures/**/*.js'],
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
    ignores: ['packages/**/*.ts', 'widgets/**/*.ts'],
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
    rules: nodeTypeScriptRules,
  },
  {
    files: ['widgets/*/src/**/*.ts'],
    ignores: ['widgets/*/src/public/**/*.ts'],
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
        project: './tsconfig.widgets.json',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: nodeTypeScriptRules,
  },
  {
    files: ['docs/.vitepress/**/*.ts', 'docs/.vitepress/**/*.mts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: false,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'no-console': 'off',
      'max-len': ['warn', { code: 120 }],
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
      parserOptions: {
        project: false,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-require-imports': 'off',
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
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: false,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-require-imports': 'off',
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
    files: ['packages/settings-ui/src/**/*.ts', 'packages/contracts/src/**/*.ts', 'packages/shared-domain/src/**/*.ts'],
    plugins: {
      functional,
      n: nodePlugin,
      sonarjs,
      unicorn,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './packages/settings-ui/tsconfig.json',
      },
    },
    rules: browserTypeScriptRules,
  },
  {
    files: ['widgets/*/src/public/**/*.ts'],
    plugins: {
      functional,
      n: nodePlugin,
      sonarjs,
      unicorn,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.widgets.json',
      },
    },
    rules: browserTypeScriptRules,
  },
  {
    files: ['packages/settings-ui/src/**/*.ts', 'widgets/*/src/public/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['packages/settings-ui/test/**/*.ts', 'packages/settings-ui/tests/**/*.ts'],
    plugins: {
      functional,
      n: nodePlugin,
      sonarjs,
      unicorn,
    },
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
      parserOptions: {
        project: false,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-require-imports': 'off',
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
  {
    files: ['app.ts'],
    rules: {
      'max-lines': ['warn', { max: 750, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: [
      'drivers/pels_insights/device.ts',
    ],
    rules: {
      'max-lines': ['warn', { max: 575, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['lib/price/priceLowestFlowEvaluator.ts'],
    rules: {
      'max-lines': ['warn', { max: 525, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['lib/price/priceService.ts'],
    rules: {
      'max-lines': ['warn', { max: 560, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['packages/settings-ui/src/ui/power.ts'],
    rules: {
      'max-lines': ['warn', { max: 650, skipBlankLines: true, skipComments: true }],
    },
  },
);
