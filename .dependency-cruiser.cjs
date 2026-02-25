/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Prevent circular dependencies.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/|settings/src/)' },
      to: { circular: true },
    },
    {
      name: 'no-runtime-to-tests',
      comment: 'Runtime code must stay isolated from tests.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/|settings/src/)' },
      to: { path: '^(test/|tests/)' },
    },
    {
      name: 'no-backend-to-settings-ui',
      comment: 'Backend runtime must not depend on UI code.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/)' },
      to: { path: '^settings/' },
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
      to: { path: '^(settings/|drivers/)' },
    },
    {
      name: 'drivers-no-settings-or-tests',
      comment: 'Driver runtime should not pull UI/test modules.',
      severity: 'error',
      from: { path: '^drivers/' },
      to: { path: '^(settings/|test/|tests/)' },
    },
    {
      name: 'no-app-imports-from-non-entry',
      comment: 'Only entry points and tests can import app.ts.',
      severity: 'error',
      from: {
        pathNot: '^(app\\.ts|test/|tests/|scripts/|playwright\\.config\\.ts|jest\\.config.*\\.cjs|settings/src/)',
      },
      to: { path: '^app\\.ts$' },
    },
    {
      name: 'todo-tighten-settings-import-surface',
      comment: 'TODO: tighten settings imports to shared contracts only.',
      severity: 'warn',
      from: { path: '^settings/src/' },
      to: { path: '^lib/', pathNot: '^lib/(utils|dailyBudget|price|core)/' },
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
    exclude: '(^node_modules/|^\\.homeybuild/|^coverage/|^output/|^playwright-report/|^test-results/)',
    combinedDependencies: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
