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
      from: { path: '^lib/(device|power|objectives|plan|price|dailyBudget|observer|executor)/' },
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
      to: { path: '^lib/(device|power|plan)/' },
    },
    // ---- Peer DAG: explicit inversions forbidden ----------------------------
    // The domain peers form a (mostly) top-down DAG:
    //   executor > plan > {power, dailyBudget, price, objectives, observer}
    //   dailyBudget > {power, price}
    //   device > power (whole-home capacity gating, tracker types)
    //   power <-> objectives (type-only cycle, file-distinct, established)
    //
    // The rules below forbid edges in the OPPOSITE direction. They are the
    // gate for lib/app dissolution: every wiring helper that today lives in
    // lib/app/ is a candidate to push into a peer; any push that creates one
    // of these forbidden edges identifies the file as cross-peer wiring
    // residue (must stay in app.ts or a successor wiring layer).
    //
    // lib/power/ mandate: WHOLE-HOME power only. Sample collection from
    // Homey, hourly/daily bucket retention, capacity threshold gating, and
    // household energy accounting (including the per-device kWh rollup that
    // feeds the whole-home view). Per-device instantaneous power estimation
    // belongs with the device layer (lib/device/devicePowerEstimate.ts);
    // per-device calibration storage belongs with the device layer too.
    {
      name: 'no-power-to-peer-except-objectives',
      comment: 'Power is a producer; only the established power <-> objectives type cycle is allowed. All other peer edges forbidden.',
      severity: 'error',
      from: { path: '^lib/power/' },
      to: { path: '^lib/(device|plan|price|dailyBudget|observer|executor)/' },
    },
    {
      name: 'no-device-to-peer-except-power',
      comment: 'Device is an SDK adapter; device may consume power (whole-home capacity/tracker types), nothing else. All other peer edges forbidden.',
      severity: 'error',
      from: { path: '^lib/device/' },
      to: { path: '^lib/(plan|price|dailyBudget|objectives|observer|executor)/' },
    },
    {
      name: 'no-observer-to-peer',
      comment: 'Observer is a leaf module; consumed by plan/executor, must not consume any other peer.',
      severity: 'error',
      from: { path: '^lib/observer/' },
      to: { path: '^lib/(device|power|plan|price|dailyBudget|objectives|executor)/' },
    },
    {
      name: 'no-price-to-peer',
      comment: 'Price is a leaf (consumed by plan and dailyBudget); must not depend on other peers.',
      severity: 'error',
      from: { path: '^lib/price/' },
      to: { path: '^lib/(device|power|plan|dailyBudget|objectives|observer|executor)/' },
    },
    {
      name: 'no-objectives-to-peer-except-power',
      comment: 'Objectives is leafward; power <-> objectives type cycle is allowed, all other peer edges forbidden.',
      severity: 'error',
      from: { path: '^lib/objectives/' },
      to: { path: '^lib/(device|plan|price|dailyBudget|observer|executor)/' },
    },
    {
      name: 'no-dailyBudget-to-peer',
      comment: 'DailyBudget is consumed by plan; may consume power and price, must not depend on any other peer.',
      severity: 'error',
      from: { path: '^lib/dailyBudget/' },
      to: { path: '^lib/(plan|device|objectives|observer|executor)/' },
    },
    // Existing inversions to track but not yet break — clean-up targets.
    {
      name: 'todo-tighten-plan-executor-boundary',
      comment: 'TODO: extract executor-needed types/predicates into lib/planContract; plan should not import executor (Phase 3 in the architecture refactor).',
      severity: 'warn',
      from: { path: '^lib/plan/' },
      to: { path: '^lib/executor/' },
    },
    {
      name: 'no-plan-to-device',
      comment: 'Plan must consume the DeviceObservation interface, not the concrete DeviceManager class or device internals. PR #1b of the observer/transport split (see notes/state-management/observer-transport-split.md). Allowed exception: the DeviceObservation interface itself. PR #2 removed the remaining type-only DeviceManager surface from lib/plan/ and lib/executor/.',
      severity: 'error',
      from: { path: '^lib/plan/' },
      to: {
        path: '^lib/device/',
        pathNot: '^lib/device/deviceObservation\\.ts$',
      },
    },
    {
      name: 'no-executor-to-device-internals',
      comment: 'Executor consumes the DeviceObservation interface only; it must not have a runtime dependency on the DeviceManager class or other device internals. PR #1b of the observer/transport split (see notes/state-management/observer-transport-split.md). PR #2 moved synthetic-capability IDs and SteppedLoadStepRequest types into packages/shared-domain/src/ (where they survive the Homey .homeybuild prune), so the previous synthetic-capability exception is no longer needed, and the remaining type-only DeviceManager references in lib/executor/ have been replaced with PlanExecutorDeviceTransport (local interface).',
      severity: 'error',
      from: { path: '^lib/executor/' },
      to: {
        path: '^lib/device/',
        pathNot: '^lib/device/deviceObservation\\.ts$',
      },
    },
  ],
  options: {
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    doNotFollow: {
      path: '^node_modules',
    },
    exclude: '(^node_modules/|^\\.claude/|^\\.homeybuild/|^coverage/|^output/|^playwright-report/|^test-results/|^packages/settings-ui/dist/)',
    combinedDependencies: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
