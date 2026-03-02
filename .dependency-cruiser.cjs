/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Prevent circular dependencies.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/|packages/(settings-ui|contracts|shared-domain)/src/)' },
      to: { circular: true },
    },
    {
      name: 'no-runtime-to-tests',
      comment: 'Runtime code must stay isolated from tests.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/|packages/(settings-ui|contracts|shared-domain)/src/)' },
      to: { path: '^(test/|tests/|packages/settings-ui/(test|tests)/)' },
    },
    {
      name: 'no-backend-to-settings-ui',
      comment: 'Backend runtime must not depend on UI code.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/)' },
      to: { path: '^packages/settings-ui/' },
    },
    {
      name: 'no-settings-ui-to-runtime',
      comment: 'Settings UI must consume shared contracts, not runtime internals.',
      severity: 'error',
      from: { path: '^packages/settings-ui/src/' },
      to: { path: '^(app\\.ts|flowCards/|drivers/|lib/)' },
    },
    {
      name: 'no-domain-to-app-layer',
      comment: 'Domain modules should not depend on app wiring.',
      severity: 'error',
      from: { path: '^lib/(core|plan|price|dailyBudget)/' },
      to: { path: '^lib/app/' },
    },
    {
      name: 'flowcards-no-settings-or-drivers',
      comment: 'Flow cards should stay app-runtime focused.',
      severity: 'error',
      from: { path: '^flowCards/' },
      to: { path: '^(packages/settings-ui/|drivers/)' },
    },
    {
      name: 'drivers-no-settings-or-tests',
      comment: 'Driver runtime should not pull UI/test modules.',
      severity: 'error',
      from: { path: '^drivers/' },
      to: { path: '^(packages/settings-ui/|test/|tests/)' },
    },
    {
      name: 'no-app-imports-from-non-entry',
      comment: 'Only entry points and tests can import app.ts.',
      severity: 'error',
      from: {
        pathNot: '^(app\\.ts|test/|tests/|scripts/|playwright\\.config\\.ts|jest\\.config.*\\.cjs|packages/settings-ui/src/)',
      },
      to: { path: '^app\\.ts$' },
    },
    {
      name: 'shared-packages-no-runtime',
      comment: 'Shared packages must remain browser-safe and runtime-agnostic.',
      severity: 'error',
      from: { path: '^packages/(contracts|shared-domain)/src/' },
      to: { path: '^(app\\.ts|flowCards/|drivers/|lib/)' },
    },
    {
      name: 'todo-tighten-utils-layering',
      comment: 'TODO: remove remaining utils -> core/plan dependencies.',
      severity: 'warn',
      from: { path: '^lib/utils/' },
      to: { path: '^lib/(core|plan)/' },
    },
  ],
  options: {
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    doNotFollow: {
      path: '^node_modules',
    },
    exclude: '(^node_modules/|^\\.homeybuild/|^coverage/|^output/|^playwright-report/|^test-results/|^packages/settings-ui/dist/)',
    combinedDependencies: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
