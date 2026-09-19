/**
 * The builder's dependencies — a named domain object held by `PlanBuilder`,
 * `SilentMeterPlanBuilder` and the wiring that constructs them (a module of its
 * own so the silent-meter pass can import it without a cycle through
 * `planBuilder.ts`).
 */
import type CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { ShedBehavior } from './planTypes';
import type { PriceOptDeviceConfig } from './planBuilderSurplus';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
} from '../../packages/planner-types/src/deferredDecoration';
import type { ResolveTemperatureSetpoints } from '../../packages/planner-types/src/temperatureSetpoints';
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';

export type PlanBuilderDeps = {
  setCapacityInShortfall: (inShortfall: boolean) => void;
  /** Per-home dry-run posture — the same fact `shouldApplyPlan` consults
   * before actuating. */
  getCapacityDryRun: () => boolean;
  capacityGuard: CapacityGuard;
  getCapacitySettings: () => CapacitySettings;
  // The surplus allocator's opt-in (`surplusWilling`, a lift configured at all).
  // The lift's VALUE is not read here: it is a setpoint, resolved before the
  // planner with every other one (`resolveTemperatureSetpoints`).
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  // Producer-resolved inferred curtailed-surplus term (kW, >= 0) for the surplus
  // allocator (zero-export homes); forwarded untouched to the per-device prep
  // pass. 0 is the whole of "nothing inferred" — see `homeScope`.
  getInferredSurplusKw: () => number;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot: () => DailyBudgetUiPayload | null;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  getDynamicSoftLimitOverride: () => number | null;
  // Observer-owned pending-binary-command store. Plan-side reads consult
  // `peek(id)` (raw read) through this facade rather than touching
  // `state.pendingBinaryCommands[id]` directly, so the store stays the
  // single source of truth for that map (observer/transport split).
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  // Smart-task (deferred-objective) decoration seam. The smart-task controller
  // (lib/objectives) evaluates objectives, commits active plans synchronously,
  // and applies admission / target-overrides / release-intents, returning a
  // `DeferredDecorationBundle`. This is the dependency inversion that keeps
  // lib/plan free of lib/objectives. A home with no smart tasks binds
  // `decorateWithoutDeferredObjectives` (the identity bundle in the seam's own
  // shape) rather than leaving the member off: "no smart tasks here" is a thing
  // a home says, not a hole the builder papers over with a default of its own.
  decorateDeferredObjectives: (input: DeferredDecorationInput) => DeferredDecorationBundle;
  // What each temperature device's outcomes command, resolved once per build
  // right after the decoration above has stamped any deadline floor. The planner
  // decides outcomes and reads setpoints from this; the mode targets, price
  // shift, deadline floor, surplus lift and the device's heating/cooling
  // direction never reach it (`lib/thermostat/temperatureSetpoints.ts`).
  resolveTemperatureSetpoints: ResolveTemperatureSetpoints;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};
