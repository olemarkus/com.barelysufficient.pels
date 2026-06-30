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
  'lib/app/appContext.ts',                   // AppContext type — the injection seam (AGENTS.md: long-term inhabitant)
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

// The consumer-side `homey` ban (no allowTypeImports), shared so the snapshot
// consumer block below can re-declare no-restricted-imports without dropping the
// homey enforcement (flat config replaces, not merges, a rule for overlapping files).
// packages/contracts is DELETED from the packaged app by
// scripts/sanitize-homey-build.mjs (types-only at runtime): a VALUE import
// from shipped runtime code crash-loops the app at boot with MODULE_NOT_FOUND
// (prod outage 2026-06-12) and no test lane can see it, because vitest/tsc
// resolve from source. The dep-cruiser rule no-runtime-value-deps-on-contracts
// is the arch gate; this lint pattern is the editor-time gate. `import type`
// stays allowed (erased at compile).
const CONTRACTS_VALUE_IMPORT_FORBID_PATTERN = {
  group: ['**/packages/contracts/**', '**/contracts/src/**', '@pels/contracts', '@pels/contracts/**'],
  allowTypeImports: true,
  message: 'packages/contracts does not exist in the packaged app (sanitize deletes it): a value '
    + 'import here crashes the app at boot. Use `import type`, or a runtime-safe duplicate '
    + '(lib/dailyBudget/dailyBudgetConstants.ts, lib/utils/settingsUiBootstrapKeys.ts pattern).',
};

const HOMEY_SDK_FORBID_PATH = {
  name: 'homey',
  message: 'Outside the device-boundary leaf, lib/** must not reference the Homey SDK at all '
    + '(no value OR type import) — depend on the lib/ports/homeyRuntime ports '
    + '(SettingsPort/ClockPort/HomeyRuntime/FlowPort/ApiPort). The SDK runtime instance is '
    + 'injected from the entry points. See notes/state-management/.',
};
// `TargetDeviceSnapshot` is the raw producer-input snapshot (DeviceDescriptor &
// ObservedDeviceState) transport builds; downstream consumer layers must not
// depend on it — they consume the decomposed halves or the discriminated plan
// device. It lives among many exports in contracts/src/types.ts, so it is matched
// by `importNames` (a patterns entry), not a whole-module path.
const TARGET_SNAPSHOT_FORBID_PATTERN = {
  group: ['**/packages/contracts/src/types'],
  importNames: ['TargetDeviceSnapshot'],
  message: 'Downstream consumer layers must not import the raw producer-input `TargetDeviceSnapshot` '
    + '— depend on the decomposed halves `ObservedDeviceState` / `DeviceDescriptor` (or a Pick of them), '
    + 'or the discriminated plan device. See notes/state-management/snapshot-decomposition.md.',
};
// Consumer layers forbidden from the raw producer snapshot. Add a dir here once
// it no longer imports `TargetDeviceSnapshot` (route its reads to the halves first).
const SNAPSHOT_CONSUMER_DIRS = [
  'lib/objectives/**/*.ts',
  'lib/plan/**/*.ts',
  'lib/executor/**/*.ts',
];
// Settings-UI imports contracts via a RELATIVE path (`../../../contracts/src/types.ts`),
// which has no `packages/` segment and keeps the `.ts` extension — so the runtime
// `TARGET_SNAPSHOT_FORBID_PATTERN` group above does not match it. This variant uses a
// settings-UI-shaped group glob to ban the same `TargetDeviceSnapshot` name from the
// browser/webview surface, which consumes the decomposed device read-models instead
// (ObservedDeviceState / DeviceDescriptor Picks / SettingsUiDeviceView). `DecoratedDeviceSnapshot`
// is intentionally NOT banned — it lives at the store definition (state.ts SettingsUiDeviceView)
// and the device payload ingest (getTargetDevices), the settings-UI's own producer boundary.
const SETTINGS_UI_SNAPSHOT_FORBID_PATTERN = {
  group: ['**/contracts/src/types', '**/contracts/src/types.ts'],
  importNames: ['TargetDeviceSnapshot'],
  message: 'The settings UI must not import the raw producer-input `TargetDeviceSnapshot` — depend on '
    + 'the decomposed device read-models (`ObservedDeviceState` / a `DeviceDescriptor` Pick / the '
    + '`SettingsUiDeviceView` store type, or the `SettingsUiDeviceListItem` / `SettingsUiDeviceDetailItem` '
    + 'carriers in deviceUtils.ts). See notes/state-management/snapshot-decomposition.md.',
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
    ignores: [...HOMEY_LEAF_ALLOWLIST, ...SNAPSHOT_CONSUMER_DIRS],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [HOMEY_SDK_FORBID_PATH],
        patterns: [CONTRACTS_VALUE_IMPORT_FORBID_PATTERN],
      }],
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  // Downstream consumer layers: the homey ban above PLUS the raw-snapshot ban.
  // Re-declares no-restricted-imports (flat config replaces it for these files)
  // so both restrictions apply; no-restricted-syntax (perf + homey dynamic-import)
  // still comes from the hot-paths block, which these dirs are also in.
  {
    files: SNAPSHOT_CONSUMER_DIRS,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [HOMEY_SDK_FORBID_PATH],
        patterns: [TARGET_SNAPSHOT_FORBID_PATTERN, CONTRACTS_VALUE_IMPORT_FORBID_PATTERN],
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
        patterns: [CONTRACTS_VALUE_IMPORT_FORBID_PATTERN],
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
  // Shipped runtime surfaces outside lib/**: same contracts value-import seal.
  // (settings-ui and widgets/** are exempt — esbuild bundles them, inlining
  // contracts; lib/** gets the pattern via the blocks above.)
  {
    files: ['app.ts', 'api.ts', 'setup/**/*.ts', 'flowCards/**/*.ts', 'drivers/**/*.ts', 'packages/shared-domain/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [CONTRACTS_VALUE_IMPORT_FORBID_PATTERN],
      }],
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
  // Seals the Role-2 snapshot boundary: the settings-UI source surface (browser/
  // webview) must consume the decomposed device read-models, never the raw
  // producer-input `TargetDeviceSnapshot`. Every surface — list, detail, price-opt,
  // control-profiles, deadline-plan — was migrated off the name before this gate
  // landed. Tests are intentionally excluded (they build snapshot fixtures).
  // browserTypeScriptRules sets no `no-restricted-imports`, so this block adds it
  // without dropping any existing restriction.
  {
    files: ['packages/settings-ui/src/**/*.ts', 'packages/settings-ui/src/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [SETTINGS_UI_SNAPSHOT_FORBID_PATTERN],
      }],
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
    // app class that constructs and connects every runtime service. The boot/teardown
    // orchestration and per-service construction now live in `setup/appServiceWiring.ts`;
    // app.ts keeps slim `onInit`/`onUninit` plus the thin `init*` delegators the
    // integration-test boot helper calls directly. What remains is irreducible without
    // breaking documented test seams: the field/helper declarations, the ~60 thin
    // AppContext/PelsWidgetHostApi delegators, and the smart-task widget API surface.
    // Ceiling just above current. Target: <=500 needs the smart-task/deferred-objective
    // API cluster and the per-domain delegator surface extracted next (TODO "Continue
    // thinning app.ts ...").
    files: ['app.ts'],
    rules: {
      'max-lines': ['warn', { max: 1110, skipBlankLines: true, skipComments: true }],
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
    // The settings UI and dashboard widgets run inside Homey's WebView, whose
    // console is unreachable on the mobile dashboard — a `console.*` there is a
    // diagnostic that silently disappears (the original "Unable to load with no
    // explanation"). Route problems through the app instead: settings UI via
    // `logSettings*` (→ `settings_ui_log`), widgets via the shared
    // `widgetErrorReporter` (→ each widget's `/log`). Both land in the Homey app
    // log. Generated widget bundles (`widgets/**/*.js`) are already ignored.
    name: 'no-console-in-webview-surfaces',
    files: [
      'packages/settings-ui/src/**/*.ts',
      'packages/settings-ui/src/**/*.tsx',
      'widgets/*/src/**/*.ts',
      'widgets/_shared/**/*.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },
);
