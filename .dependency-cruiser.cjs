/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Prevent circular dependencies.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/|setup/|packages/(settings-ui|contracts|shared-domain|planner-types)/src/)' },
      to: { circular: true },
    },
    {
      name: 'no-runtime-to-tests',
      comment: 'Runtime code must stay isolated from tests.',
      severity: 'error',
      from: { path: '^(app\\.ts|flowCards/|drivers/|lib/|setup/|packages/(settings-ui|contracts|shared-domain|planner-types)/src/)' },
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
      from: { path: '^lib/(device|power|objectives|plan|price|dailyBudget|observer|executor|actuator)/' },
      to: { path: '^lib/app/' },
    },
    {
      name: 'no-lib-to-setup',
      comment: 'setup/ hosts app-specific wiring classes (constructor of services, '
        + 'observers, registrars). Domain code under lib/** and shared packages must '
        + 'never depend on setup/ — the arrow always points from setup/ down into '
        + 'the libraries it wires.',
      severity: 'error',
      from: { path: '^(lib/|packages/)' },
      to: { path: '^setup/' },
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
      name: 'no-widget-to-runtime-except-node-entries',
      comment: 'Widget source must stay browser-safe: the public/** bundle runs in '
        + 'Homey\'s widget WebView, and types/preview-fixtures/render helpers feed it. '
        + 'These must consume only shared contracts/shared-domain and sibling widget '
        + 'files — never the app runtime (app.ts, flowCards/, drivers/, lib/, setup/). '
        + 'The only exception is a widget\'s node entries, which run in the app process '
        + 'when the widget requests data: api.ts (the Homey API handler) and the '
        + '*WidgetPayload.ts builders may bridge to lib helpers (e.g. '
        + 'create_smart_task/src/api.ts imports lib/objectives/deferredObjectives; '
        + 'plan_budget/src/planPriceWidgetPayload.ts imports lib/dailyBudget types). '
        + 'This catches only DIRECT public->runtime edges. The transitive '
        + 'public/** -> *WidgetPayload.ts -> lib path is closed separately by the '
        + 'no-public-to-node-entry rule below (which forbids public/** from importing '
        + 'the lib-bridging node entries at all), so a future VALUE import in a node '
        + 'builder can never reach the WebView bundle.',
      severity: 'error',
      from: {
        path: '^widgets/[^/]+/src/',
        pathNot: '^widgets/[^/]+/src/(api\\.ts|[^/]*WidgetPayload\\.ts)$',
      },
      to: { path: '^(app\\.ts|flowCards/|drivers/|lib/|setup/)' },
    },
    {
      name: 'no-public-to-node-entry',
      comment: 'The public/** WebView bundle must not import a widget\'s node entries '
        + '(api.ts, *WidgetPayload.ts). Those are the only widget files allowed to '
        + 'bridge to the app runtime (lib/, etc.), so a VALUE import of one into the '
        + 'browser bundle would transitively pull runtime code into the WebView while '
        + 'the no-widget-to-runtime-except-node-entries rule (which only sees DIRECT '
        + 'public->runtime edges) stays green. Browser-safe constants and types the '
        + 'public bundle needs live in sibling modules (*WidgetConstants.ts, '
        + '*WidgetTypes.ts) the node entries also import — never the other way round. '
        + 'NB: tsPreCompilationDeps is unset, so this catches VALUE imports (the ones '
        + 'that actually bundle); type-only public->node-entry edges are erased and '
        + 'harmless.',
      severity: 'error',
      from: { path: '^widgets/[^/]+/src/public/' },
      to: { path: '^widgets/[^/]+/src/(api\\.ts|[^/]*WidgetPayload\\.ts)$' },
    },
    {
      name: 'no-public-reaches-runtime',
      comment: 'Belt-and-suspenders transitive closure for the WebView bundle. The '
        + 'two rules above forbid the DIRECT public->runtime and public->node-entry '
        + 'edges, but a longer sibling chain could still smuggle runtime code into the '
        + 'browser bundle — e.g. public/** -> *WidgetConstants.ts -> *WidgetPayload.ts '
        + '-> lib: a constants module value-importing a node builder is caught by '
        + 'neither direct rule (the constants->builder hop targets a sibling widget '
        + 'file, and the builder->lib hop is the sanctioned node-entry exception). '
        + 'This rule forbids public/** from REACHING the app runtime by ANY '
        + 'value-import path, so no future intermediate hop can reopen the hole while '
        + 'arch:check stays green. tsPreCompilationDeps is unset, so reachability '
        + 'follows the value imports that actually bundle; type-only edges are erased.',
      severity: 'error',
      from: { path: '^widgets/[^/]+/src/public/' },
      to: {
        path: '^(app\\.ts|flowCards/|drivers/|lib/|setup/)',
        reachable: true,
      },
    },
    {
      name: 'shared-packages-no-runtime',
      comment: 'Shared packages must remain browser-safe and runtime-agnostic. '
        + '@pels/planner-types holds the planner I/O contracts (PlanInputDevice) '
        + 'below the domain peer layer so producer modules outside lib/plan (the '
        + 'smart-task controller in lib/objectives) can import them downward as '
        + 'their CONCEPTUAL/value-graph home. NB: this rule only enforces the '
        + 'planner-types -> runtime VALUE-import ban (real, post-compilation). It '
        + 'does NOT, by itself, prevent an objectives -> lib/plan peer inversion: '
        + 'that import is type-only and so invisible to this post-compilation '
        + 'cruise (see the no-plan-to-smarttasks caveat below). The relocation\'s '
        + 'load-bearing payoff for the finish line is the manual grep audit '
        + '(objectives imports @pels/planner-types, never lib/plan), not cruiser '
        + 'green. planner-types must depend only on sibling shared packages '
        + '(e.g. @pels/contracts), never on the app runtime.',
      severity: 'error',
      from: { path: '^packages/(contracts|shared-domain|planner-types)/src/' },
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
      name: 'no-actuator-to-peer',
      comment: 'Actuator is the single write seam: it maps channel-blind DeviceCommands onto '
        + 'an injected transport write surface (transport stays the sole SDK owner). It is a pure '
        + 'leaf — it must not import any peer (device/transport included; the write surface is '
        + 'injected as a local interface, never imported). See '
        + 'notes/state-management/actuator-write-seam.md.',
      severity: 'error',
      from: { path: '^lib/actuator/' },
      to: { path: '^lib/(device|power|plan|price|dailyBudget|objectives|observer|executor)/' },
    },
    {
      name: 'no-actuator-bypass',
      comment:
        'PR1b-final close-out: the actuator is now the SOLE device write path — every executor '
        + 'write site (binary / target / step) routes through the injected `Actuator.apply` '
        + 'interface. lib/plan/** and lib/executor/** RECEIVE an `Actuator` (injected via deps); they '
        + 'must NOT reach into the actuator package to build or wire their own write path — i.e. no '
        + 'value import from lib/actuator/** (notably `createDeviceActuator`, which only setup/** may '
        + 'call — see setup/appInit/buildDeviceActuator.ts). The legitimate edge is '
        + '`import type { Actuator }`, which is erased and thus invisible to this cruise, so it stays '
        + 'allowed automatically. This complements the device-boundary rules (no-plan-to-device, '
        + 'no-executor-to-device-internals) by closing the actuator-side bypass. HONESTY CAVEAT: '
        + 'tsPreCompilationDeps is unset, so this catches only VALUE imports (e.g. `createDeviceActuator`); '
        + 'the type-only `ActuatorTransport`/`DeviceCommand`/`Actuator` edges are erased. And no import '
        + 'rule can forbid a raw `.setCapability()` CALL — that half is enforced STRUCTURALLY: the '
        + 'executor transport view is now `PlanExecutorDeviceTransport = DeviceObservation` (write-free), '
        + 'so the only write path it has is the injected `Actuator`. See '
        + 'notes/state-management/actuator-write-seam.md.',
      severity: 'error',
      from: { path: '^lib/(plan|executor)/' },
      to: { path: '^lib/actuator/' },
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
      name: 'no-plan-to-smarttasks',
      comment:
        'DEFINITION-OF-DONE for the smart-task controller extraction (see '
        + 'notes/state-management/deferred-objective-lifecycle-carveout.md), now ENFORCED: the planner '
        + 'knows nothing about smart tasks. lib/plan/** must not import the deferred-objective '
        + '(smart-task) subsystem at lib/objectives/deferredObjectives/. The input-decoration '
        + 'appliers + objective eval moved onto the DeferredObjectiveDecorationController in PR-D2; '
        + 'lib/plan now consumes only the flat DeferredDecorationBundle (@pels/planner-types) through '
        + 'the injected `decorateDeferredObjectives` seam, constructed in the app-wiring layer '
        + '(lib/app/appInit.ts). CAVEAT (still true): this config runs post-compilation '
        + '(tsPreCompilationDeps unset), so `import type` edges are INVISIBLE — this rule counts only '
        + 'VALUE imports. The type-edge gap is now closed by an enforced grep guard '
        + '(`npm run arch:grep` → scripts/check-plan-objectives-edge.mjs), wired into ci:checks and '
        + 'the CI checks job, which fails on ANY lib/plan -> objectives from-specifier (value OR type). '
        + 'tsPreCompilationDeps was deliberately NOT flipped (it surfaces ~18 pre-existing type-only '
        + 'no-circular violations and doubles the cruised graph — see TODO.md). Run `npm run arch:grep` '
        + 'before adding any lib/plan import that the cruiser might wave through as type-only.',
      severity: 'error',
      from: { path: '^lib/plan/' },
      to: { path: '^lib/objectives/deferredObjectives/' },
    },
    {
      name: 'no-plan-to-device',
      comment: 'Plan must consume the DeviceObservation interface, not the concrete DeviceTransport class or device internals. PR #1b of the observer/transport split (see notes/state-management/observer-transport-split.md). Allowed exceptions: the DeviceObservation interface itself, the deviceActionProjection producer seam (chunk 1 of the planner-detype refactor — pure resolvers physically owned by the device layer, consumed by plan-side shims), and the deviceResidualKw producer seam (chunk 3). PR #2 removed the remaining type-only DeviceManager surface from lib/plan/ and lib/executor/; PR #3 renamed the class to DeviceTransport.',
      severity: 'error',
      from: { path: '^lib/plan/' },
      to: {
        path: '^lib/device/',
        pathNot: '^lib/device/(deviceObservation|deviceActionProjection|deviceResidualKw)\\.ts$',
      },
    },
    {
      name: 'no-device-action-projection-to-plan',
      comment: 'The deviceActionProjection producer seam must stay pure: no transitive imports from lib/plan/**. This is the layering invariant that lets plan-side shims re-export the moved helpers without creating a producer<->consumer cycle (chunk 1 of the planner-detype refactor).',
      severity: 'error',
      from: { path: '^lib/device/deviceActionProjection\\.ts$' },
      to: { path: '^lib/plan/' },
    },
    {
      name: 'no-device-residual-kw-to-plan',
      comment: 'The deviceResidualKw producer seam must stay pure: no transitive imports from lib/plan/** or lib/observer/**. Mirrors the deviceActionProjection invariant for chunk 3 of the planner-detype refactor.',
      severity: 'error',
      from: { path: '^lib/device/deviceResidualKw\\.ts$' },
      to: { path: '^lib/(plan|observer)/' },
    },
    {
      name: 'no-executor-to-device-internals',
      comment: 'Executor consumes the DeviceObservation interface only; it must not have a runtime dependency on the DeviceTransport class or other device internals. PR #1b of the observer/transport split (see notes/state-management/observer-transport-split.md). PR #2 moved synthetic-capability IDs and SteppedLoadStepRequest types into packages/shared-domain/src/ (where they survive the Homey .homeybuild prune), so the previous synthetic-capability exception is no longer needed, and the remaining type-only DeviceManager references in lib/executor/ have been replaced with PlanExecutorDeviceTransport (local interface). PR #3 renamed the concrete class from DeviceManager to DeviceTransport.',
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
