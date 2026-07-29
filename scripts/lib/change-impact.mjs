import path from 'node:path';

export const RUNTIME_PATHS = Object.freeze([
  'app.ts',
  'api.ts',
  'drivers/',
  'flowCards/',
  'lib/',
  'setup/',
  'test/',
  'widgets/',
  'packages/contracts/src/',
  'packages/contracts/package.json',
  'packages/shared-domain/src/',
  'packages/shared-domain/package.json',
  'packages/planner-types/src/',
  'scripts/',
  'package.json',
  'package-lock.json',
  'vitest.shared.mts',
  'vitest.config.',
  'vitest-env.d.ts',
]);

export const SETTINGS_UI_UNIT_PATHS = Object.freeze([
  'packages/settings-ui/src/',
  'packages/settings-ui/test/',
  'packages/settings-ui/public/',
  'packages/settings-ui/scripts/',
  'packages/settings-ui/style-dictionary.config.mjs',
  'packages/settings-ui/package.json',
  'packages/settings-ui/vitest.config.',
  'packages/contracts/src/',
  'packages/contracts/package.json',
  'packages/shared-domain/src/',
  'packages/shared-domain/package.json',
  'settings/tokens.css',
  'tokens/',
]);

export const MANIFEST_PATHS = Object.freeze([
  '.homeycompose/',
  'app.json',
  'drivers/',
  'widgets/',
  'scripts/check-homey-packaging.mjs',
]);

export const RUNTIME_TEST_WIRING_PATHS = Object.freeze([
  'test/setup.ts',
  'test/mocks/',
  'package.json',
  'package-lock.json',
  'packages/contracts/package.json',
  'packages/shared-domain/package.json',
  'vitest.shared.mts',
  'vitest.config.mts',
  'vitest.config.unit.mts',
  'vitest.config.integration.mts',
  'vitest.config.e2e.mts',
  'vitest.config.tz.mts',
  'vitest.config.changed.mts',
  'vitest-env.d.ts',
]);

export const SETTINGS_UI_TEST_WIRING_PATHS = Object.freeze([
  'packages/settings-ui/test/setup.ts',
  'packages/settings-ui/public/',
  'packages/settings-ui/vitest.config.ts',
  'packages/settings-ui/vitest.config.layout.ts',
  'packages/settings-ui/style-dictionary.config.mjs',
  'packages/settings-ui/package.json',
  'packages/contracts/package.json',
  'packages/shared-domain/package.json',
  'settings/tokens.css',
  'tokens/',
]);

const SETTINGS_UI_E2E_PATHS = Object.freeze([
  'packages/settings-ui/scripts/',
  'packages/settings-ui/tests/e2e/',
  'packages/settings-ui/playwright.config.ts',
]);

const TEST_INFRA_PATHS = Object.freeze([
  '.stylelintrc.cjs',
  '.github/actions/setup/',
  '.github/workflows/test.yml',
  'package.json',
  'package-lock.json',
  'scripts/ci-',
  'scripts/pre-commit',
  'scripts/pre-push',
  'scripts/run-timezone-tests.mjs',
  'scripts/test-unit-ci.mjs',
  'scripts/classify-change-impact.mjs',
  'scripts/lib/change-impact.mjs',
  'scripts/lib/run-parallel.mjs',
  'scripts/with-validation-lock.mjs',
]);

const BROWSER_RISK_PATHS = Object.freeze([
  'packages/settings-ui/public/',
  'packages/settings-ui/scripts/',
  'packages/settings-ui/src/',
  'packages/settings-ui/tests/e2e/',
  'packages/settings-ui/style-dictionary.config.mjs',
  'packages/settings-ui/playwright.config.ts',
  'settings/tokens.css',
  'tokens/',
]);

const DOCS_INFRA_PATHS = Object.freeze([
  '.github/actions/setup/',
  '.github/workflows/test.yml',
]);

export const matchesAnyPath = (files, patterns) => files.some((file) => (
  patterns.some((pattern) => file === pattern || file.startsWith(pattern))
));

export const normalizeRepositoryFiles = (files, cwd = process.cwd()) => [...new Set(
  files.map((file) => path.relative(cwd, path.resolve(cwd, file)).replaceAll(path.sep, '/')),
)];

export const selectMatchingPaths = (files, patterns) => (
  files.filter((file) => matchesAnyPath([file], patterns))
);

const isCaptureSpec = (file) => /screenshots?\.spec\.ts$/u.test(file);

export const classifyChangeImpact = (files) => {
  const testInfrastructure = matchesAnyPath(files, TEST_INFRA_PATHS);
  const runtime = testInfrastructure || matchesAnyPath(files, RUNTIME_PATHS);
  const settingsUi = testInfrastructure
    || matchesAnyPath(files, [...SETTINGS_UI_UNIT_PATHS, ...SETTINGS_UI_E2E_PATHS]);
  const chartSourceChanged = files.some((file) => (
    file.startsWith('packages/settings-ui/src/')
      && /chart/i.test(file)
  ));
  const browserRisk = testInfrastructure
    || chartSourceChanged
    || matchesAnyPath(files, BROWSER_RISK_PATHS);
  const playwrightFull = files.includes('packages/settings-ui/playwright.config.ts')
    || files.includes('packages/settings-ui/package.json')
    || files.includes('package-lock.json');
  const e2eSpecs = files
    .filter((file) => (
      file.startsWith('packages/settings-ui/tests/e2e/')
        && file.endsWith('.spec.ts')
        && !isCaptureSpec(file)
    ))
    .map((file) => file.slice('packages/settings-ui/'.length));

  return {
    runtime,
    settingsUi,
    browserRisk,
    docs: matchesAnyPath(files, DOCS_INFRA_PATHS)
      || files.some((file) => (
        file.startsWith('docs/')
          || file === 'package.json'
          || file === 'package-lock.json'
      )),
    playwrightFull,
    e2eSpecs,
  };
};
