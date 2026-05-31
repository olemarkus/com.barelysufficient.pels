import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import nodePlugin from 'eslint-plugin-n';
import functional from 'eslint-plugin-functional';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
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
      '.chrome-homey-profile/**',
      '.firefox-homey-profile/**',
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
      'vitest.config*.ts',
      'vitest.config*.mts',
      'vitest-env.d.ts',
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
    files: ['lib/device/**/*.ts', 'lib/plan/**/*.ts', 'lib/dailyBudget/**/*.ts', 'lib/objectives/**/*.ts', 'lib/power/**/*.ts'],
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
        ...globals.vitest,
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
    // Guard the settings UI against HTML-injection sinks (`innerHTML`, `outerHTML`,
    // `insertAdjacentHTML`, `document.write`, …). Constant strings are allowed by the
    // plugin; only dynamic/computed assignments are flagged. This also reinforces the
    // imperative→JSX migration (the canonical components don't build markup as strings).
    files: ['packages/settings-ui/src/**/*.ts', 'packages/settings-ui/src/**/*.tsx'],
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
    },
  },
  {
    // The redesigned views render exclusively through Preact JSX (views/AGENTS.md).
    // Forbid imperative DOM *construction/mutation* so that policy is enforced, not
    // just documented — locking in the JSX surface and preventing regressions to the
    // old createElement builders. DOM *reads* (e.g. querySelector for layout
    // measurement) and the sanctioned `useRef`/`useLayoutEffect` Material-Web property
    // interop set JS properties, not DOM structure, so they are unaffected.
    files: ['packages/settings-ui/src/ui/views/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='document'][callee.property.name=/^createElement(NS)?$/]", message: 'No imperative DOM in views — render via Preact JSX.' },
        { selector: "CallExpression[callee.property.name=/^(appendChild|insertBefore|replaceChild|removeChild|prepend|replaceChildren)$/]", message: 'No imperative DOM mutation in views — render via Preact JSX.' },
        { selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]", message: 'No innerHTML in views — render via Preact JSX.' },
        // Homey injects a host stylesheet (`_base.css`) into the app settings
        // iframe whose "legacy button" rule
        // `button:not(.hy-nostyle):not([class*='homey-button']):not([class*='hy-button'])`
        // (specificity (0,3,1), loaded after our sheet) forces light-grey
        // `#e7e7e7` chrome onto any native <button> lacking an opt-out class —
        // invisible in light theme, a glaring light rectangle in our dark theme.
        // Every native <button> must carry the `hy-nostyle` class so the host
        // rule can't match it (the doubled-class specificity trick on
        // `.segmented__option` / `.pels-button` was applied per-element and was
        // forgotten on the filter chips + hero sub-line — this guard makes the
        // opt-out impossible to forget). Static class string required.
        { selector: "JSXOpeningElement[name.name='button']:not(:has(JSXAttribute[name.name=/^(class|className)$/] :matches(Literal[value=/(^| )hy-nostyle( |$)/], TemplateElement[value.cooked=/(^| )hy-nostyle( |$)/])))", message: "Native <button> must include the `hy-nostyle` class so Homey's host button stylesheet can't bleed light-grey chrome onto it in dark theme (see style.css host-bleed notes)." },
        // NB: <label> needs no such guard — unlike buttons, PELS already carries a
        // global `label { … !important }` override (style.css:146) that beats the
        // host `label:not(.hy-nostyle)` rule for every label, static or dynamic.
        // The regression in homey-button-bleed.spec.ts guards that override.
      ],
    },
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
        ...globals.vitest,
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
    // app.ts remains the central lifecycle/service wiring entrypoint while the remaining
    // delegate, timer, and AppContext cleanup lands. Target: <=500 after complexity-cleanup
    // Phases 4, 10, and 11 complete.
    files: ['app.ts'],
    rules: {
      'max-lines': ['warn', { max: 750, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // DeviceManager still owns snapshot refresh, realtime drift reconciliation, and binary settle
    // windows over one shared mutable snapshot. Target: <=850 after the post-Phase-7 helper
    // cleanup trims the remaining orchestration bulk.
    files: ['lib/device/manager.ts'],
    rules: {
      'max-lines': ['warn', { max: 900, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // parseDevice keeps Homey snapshot normalization local while target/power parsing continues to
    // settle at the Homey boundary. Target: <=140 after the next helper extraction pass.
    files: ['lib/device/transport/managerParseDevice.ts'],
    rules: {
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Stateful starvation diagnostics keep persistence, episode accounting, and Settings UI
    // payload shaping in one service until the notes/starvation rollout finishes. Target: <=1200
    // until that follow-up split is ready.
    files: ['lib/diagnostics/deviceDiagnosticsService.ts'],
    rules: {
      'max-lines': ['warn', { max: 1200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // planExecutor keeps the remaining binary-control dispatch table local so the actuation path
    // stays navigable in one place. Predicate helpers now live in `planExecutorPredicates.ts`
    // and shed_release actuation lives in `shedReleaseActuation.ts`. Target: <=600 if the binary
    // dispatch table itself is later split per control type.
    files: ['lib/executor/planExecutor.ts'],
    rules: {
      'max-lines': ['warn', { max: 730, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // planDevices is the main materialiser for `DevicePlanDevice` from `PlanInputDevice`; every
    // chunk of the planner-detype refactor touches it. Chunk 5 added a producer-resolved
    // `shedIntent` dual-read path alongside the legacy `resolveShedAction` branches; chunk 6
    // removes the legacy fallback (and shrinks the file back to <500). Bump the cap until then.
    files: ['lib/plan/planDevices.ts'],
    rules: {
      'max-lines': ['warn', { max: 540, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // The compatibility wrapper still keeps power-sample state and promise plumbing local while
    // PlanRebuildScheduler owns the cross-intent queue. `schedulePlanRebuildFromPowerSample`
    // remains a long orchestration function — keep `max-lines-per-function` raised until
    // its decision-table flow can be split.
    files: ['lib/plan/rebuildScheduler/powerDriven.ts'],
    rules: {
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // deferredPlanHistory aggregates the smart-task history formatters (postmortem, missed
    // reason, observed coverage, overshoot line, chart-data resolver). v2.7.2 PR 6 added the
    // overshoot helper + Usage-link label + miss-streak resolver; v2.7.3 stall promotion
    // added `met-by-stall` variant + `resolveStalledMetPostmortem`, pushing the file
    // further past the 500-line budget. Target: <=500 once a future PR splits the
    // chart-data resolver (`deferredPlanHistoryChartData.ts`) out from the
    // postmortem/list-shape helpers. Bumped in v2.9.x for the
    // `met-by-device-cap` postmortem variant + resolver, then again for the
    // `unknown`-with-plan postmortem branch (PR #1074 follow-up). Bumped
    // again for the revision-log `hourDiffAriaLabel` formatter + normalize
    // helper (PR #1197 follow-up batch 3).
    files: ['packages/shared-domain/src/deferredPlanHistory.ts'],
    rules: {
      'max-lines': ['warn', { max: 635, skipBlankLines: true, skipComments: true }],
    },
  },
);
