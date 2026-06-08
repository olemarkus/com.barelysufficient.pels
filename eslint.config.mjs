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

// The ONLY lib/** files allowed to reference the `homey` package — and only as
// a TYPE. These type the raw injected SDK instance as `Homey.App`: the
// device-boundary leaf (the sole place that talks to the SDK) plus the
// AppContext injection seam. Every other lib/** module depends on the SDK-free
// ports in lib/ports/homeyRuntime instead.
const HOMEY_LEAF_ALLOWLIST = [
  'lib/app/appContext.ts',                   // AppContext type — the injection seam (CLAUDE.md: long-term inhabitant)
  'lib/device/deviceTransport.ts',           // the SDK transport leaf
  'lib/device/liveFeed.ts',                  // local Web API socket.io subscription
  'lib/device/transport/managerHomeyApi.ts', // local HTTP API client
];

// Dynamic `import('homey')` is a runtime value-load, so it bypasses the
// `no-restricted-imports` paths gate (which only sees static import/import type).
// `require('homey')` is sealed separately by turning `no-require-imports` on for
// lib/**. Hot-path dirs already set `no-restricted-syntax` (perf selectors), and
// flat config REPLACES rather than merges, so this selector is added INTO the
// perf block there and applied via a sibling block to the remaining lib dirs.
const HOMEY_DYNAMIC_IMPORT_BAN = {
  selector: "ImportExpression[source.value='homey']",
  message: 'Do not dynamic-import the Homey SDK in lib/** — depend on lib/ports/homeyRuntime '
    + '(the device-boundary leaf type-imports `Homey.App`; nobody value-loads the SDK).',
};
const HOMEY_HOT_PATH_DIRS = [
  'lib/device/**/*.ts',
  'lib/plan/**/*.ts',
  'lib/dailyBudget/**/*.ts',
  'lib/objectives/**/*.ts',
  'lib/power/**/*.ts',
];

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
      'lib/price/nettleieFallbackData.generated.ts',
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
    // The widget harness mount script runs in the browser (injects a fake Homey
    // into each widget iframe), so it needs browser globals on top of node.
    files: ['tests/widget-harness/harness.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
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
        // SDK-leaf gate: dynamic `import('homey')` (hot-path dirs). The rest of
        // lib/** gets this via the sibling block below the leaf rules.
        HOMEY_DYNAMIC_IMPORT_BAN,
      ],
    },
  },
  // Keep the Homey SDK at the leaf. The runtime SDK object (`homey.settings` /
  // `clock` / `api` / `flow`) is dependency-injected from the entry points
  // (app.ts and drivers/** subclass `Homey.App`/`Homey.Driver` and thread the
  // instance down); the domain depends on the SDK-free ports in
  // lib/ports/homeyRuntime instead. So `lib/**` must not reference the `homey`
  // package AT ALL — value or type — except the device-boundary leaf and the
  // appContext injection seam (HOMEY_LEAF_ALLOWLIST), the only places that
  // legitimately type the raw injected instance. `homey` is a types-only package
  // (@types/homey → homey-apps-sdk-v3-types), so dependency-cruiser (which runs
  // post-compilation, where the edges are erased) can't police this — the
  // source-level lint rule is the only honest gate. Three forms are sealed:
  // static import/import type (no-restricted-imports below), `require('homey')`
  // (no-require-imports), and dynamic `import('homey')` (no-restricted-syntax).
  {
    files: ['lib/**/*.ts'],
    ignores: HOMEY_LEAF_ALLOWLIST,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{
          name: 'homey',
          message: 'Outside the device-boundary leaf, lib/** must not reference the Homey SDK at all '
            + '(no value OR type import) — depend on the lib/ports/homeyRuntime ports '
            + '(SettingsPort/ClockPort/HomeyRuntime/FlowPort/ApiPort). The SDK runtime instance is '
            + 'injected from the entry points. See notes/state-management/.',
        }],
      }],
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  // The device-boundary leaf + the appContext injection seam: the only lib/**
  // files that may reference `homey`, and only as a TYPE (`import type Homey` to
  // annotate the injected instance as `Homey.App`). A value import is still
  // forbidden — the runtime instance is injected, never imported.
  {
    files: HOMEY_LEAF_ALLOWLIST,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{
          name: 'homey',
          allowTypeImports: true,
          message: 'Even the SDK-boundary leaf must not VALUE-import `homey` — the runtime instance is '
            + 'injected from the entry points (app.ts/drivers). `import type Homey` is allowed here only.',
        }],
      }],
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  // Dynamic-import seal for the non-hot-path lib dirs (the hot-path dirs get
  // HOMEY_DYNAMIC_IMPORT_BAN via the perf block's no-restricted-syntax above;
  // flat config replaces this rule, so it can't be set in one lib-wide block
  // without clobbering the perf selectors).
  {
    files: ['lib/**/*.ts'],
    ignores: HOMEY_HOT_PATH_DIRS,
    rules: {
      'no-restricted-syntax': ['error', HOMEY_DYNAMIC_IMPORT_BAN],
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
    // app.ts is the central Homey app-lifecycle/service-wiring entrypoint: it owns the
    // app class that constructs and connects every runtime service. The prior blanket
    // `/* eslint-disable max-lines */` masked the true size; with it removed the file
    // measures ~1885 effective lines. Bucket B for now with a ceiling just above current.
    // Target: <=500 once the delegate/timer/AppContext extraction (TODO "Continue thinning
    // app.ts ...") moves the remaining wiring into `setup/appInit/**`.
    files: ['app.ts'],
    rules: {
      'max-lines': ['warn', { max: 1900, skipBlankLines: true, skipComments: true }],
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
    // and shed_release actuation lives in `shedReleaseActuation.ts`. The cap ticks up as the
    // actuator-write-seam migration (PR1b) routes write sites through the injected `Actuator`
    // dep; it shrinks again once binary/target/step dispatch is fully migrated. Target: <=600 if
    // the binary dispatch table itself is later split per control type.
    files: ['lib/executor/planExecutor.ts'],
    rules: {
      'max-lines': ['warn', { max: 734, skipBlankLines: true, skipComments: true }],
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
    // The receipt producer composes six asymmetric smart-task history surfaces
    // (succeeded timeline, missed shortfall chip, cost chip, abandoned details,
    // ISO-week archive, 7-day strip). Externalizing its user-visible strings
    // into `deferredPlanHistoryReceiptStrings.ts`
    // (per `feedback_ui_text_shared_with_logs`) adds a ~30-line named-import
    // block that pushes the producer just over the 500 cap; the strings
    // themselves now live in the sibling module. Capped tightly so the producer
    // can't grow new logic under the allowance — the +5 over the original 540
    // is the cost-divisor scaling wiring (the øre→kr fix); its actual scaling
    // helper + `WeekCostDisplay` type live in the sibling strings module, so
    // only the import + per-producer divisor threading remains here. Bumped to
    // 555 for cost-display provenance: each cost line now resolves the entry's
    // RECORDED `CostDisplay` (so a scheme switch can't relabel an archived
    // figure) and the ISO-week roll-up sums per-entry display cost + resolves a
    // heading unit for mixed-scheme weeks. Reinforces the split-out target.
    files: ['packages/shared-domain/src/deferredPlanHistoryReceipt.ts'],
    rules: {
      'max-lines': ['warn', { max: 555, skipBlankLines: true, skipComments: true }],
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
    // helper (PR #1197 follow-up batch 3). Bumped for the met-then-cooled
    // displayed-end resolver (`resolveDisplayedEndValue`) that floors a met
    // run's shown end at target so a "Succeeded · 64 → 39 °C" row no longer
    // reads as a drop — and again when that resolver took a `metReason` arg to
    // exclude stall-promoted mets (whose below-target plateau is intentional).
    // Bumped by one to 656 for the cost-display provenance fallback resolver.
    // Still targeting <=500 once the split lands.
    files: ['packages/shared-domain/src/deferredPlanHistory.ts'],
    rules: {
      'max-lines': ['warn', { max: 656, skipBlankLines: true, skipComments: true }],
    },
  },
  // ---------------------------------------------------------------------------
  // Documented `max-lines` exceptions migrated out of file-level blanket
  // `/* eslint-disable max-lines */` pragmas (Bucket B in
  // `notes/complexity-cleanup/god-file-policy.md`). Each carries the structural
  // reason it is centralized plus a concrete ceiling just above the file's
  // current effective size, so the file can't grow new bulk under the
  // allowance. Files that still want to reach <=500 have a named refactor entry
  // in TODO.md (persona: contributor).
  // ---------------------------------------------------------------------------
  {
    // Centralized device transport: owns SDK setup, snapshot refresh, realtime
    // drift reconciliation, binary-settle ops, observedStateDispatcher wiring,
    // and all device writes in one coordination point. Only split on a clear
    // subsystem boundary (god-file-policy.md Bucket B). Target: <=500 once a
    // transport subsystem peels off.
    files: ['lib/device/deviceTransport.ts'],
    rules: {
      'max-lines': ['warn', { max: 2185, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Flat Homey Flow-card registration surface — one big registrar that wires
    // every trigger/condition/action card. No branching logic to extract; only
    // split if registration gains deeper per-card behavior (god-file-policy.md).
    files: ['flowCards/registerFlowCards.ts'],
    rules: {
      'max-lines': ['warn', { max: 1140, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Binary restore gating + priority-swap flow kept together so the
    // restore-decision state machine reads top-to-bottom. Target: <=500 once the
    // swap-flow helpers split from the per-device restore gating.
    files: ['lib/plan/restore/index.ts'],
    rules: {
      'max-lines': ['warn', { max: 1340, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Plan builder composes planning context, overshoot tracking, and plan-meta
    // construction in one cohesive pass over the device set. Target: <=500 once
    // overshoot tracking and meta construction split into sibling builders.
    files: ['lib/plan/planBuilder.ts'],
    rules: {
      'max-lines': ['warn', { max: 1075, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Observation tracking keeps freshness, retained observations, and debug
    // source state together for one device-observation lifecycle. (Retains its
    // separate file-level `max-params` exception below for the move-only field
    // mirroring.) Target: <=500 once retained-observation accounting splits out.
    files: ['lib/device/transport/managerObservation.ts'],
    rules: {
      'max-lines': ['warn', { max: 1015, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Reason normalization and shed-temperature hold decisions share stateful
    // helpers here (the hold-cause gating reads several mutually-exclusive
    // reasons). Target: <=500 once reason normalization splits from the
    // temperature-hold decision table.
    files: ['lib/plan/planReasons.ts'],
    rules: {
      'max-lines': ['warn', { max: 1015, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Plan service keeps rebuild/reconcile sequencing in one place so the
    // intent-queue ordering stays navigable. Target: <=500 once reconcile
    // sequencing splits from rebuild orchestration.
    files: ['lib/plan/planService.ts'],
    rules: {
      'max-lines': ['warn', { max: 790, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Extracted stepped-load actuation is one cohesive, invariant-heavy
    // sequencing pipeline (step selection, recent-draw escalation, confirmation)
    // that must stay local after the executor split. Companion to the
    // `targetExecutor` / `binaryExecutor` Bucket-B entries.
    files: ['lib/executor/steppedLoadExecutor.ts'],
    rules: {
      'max-lines': ['warn', { max: 785, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Active-plan recorder keeps recording, diagnostics, and replay for one
    // deferred-objective lifecycle together (they share the recorded-revision
    // state). Target: <=500 once replay splits from the recorder.
    files: ['lib/objectives/deferredObjectives/activePlanRecorder.ts'],
    rules: {
      'max-lines': ['warn', { max: 755, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Diagnostics bridge keeps one payload-build pipeline per concern, mapping
    // objective/power state into Settings-UI diagnostics shapes. Target: <=500
    // once the per-concern payload builders split into sibling modules.
    files: ['lib/objectives/deferredObjectives/diagnosticsBridge.ts'],
    rules: {
      'max-lines': ['warn', { max: 750, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Debug-dump helpers intentionally keep every emitted debug-payload shape in
    // one place so the dump format is reviewable top-to-bottom. (Retains its
    // file-level `functional/immutable-data` exception for local payload
    // assembly.) Target: <=500 once the comparison serializer splits out.
    files: ['setup/appDebugHelpers.ts'],
    rules: {
      'max-lines': ['warn', { max: 720, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Restore helper decisions and their countdown/back-off metadata are kept
    // together so a restore decision and the data it emits read as one unit.
    // Target: <=500 once countdown-metadata shaping splits from the decisions.
    files: ['lib/plan/restore/helpers.ts'],
    rules: {
      'max-lines': ['warn', { max: 710, skipBlankLines: true, skipComments: true }],
    },
  },
);
