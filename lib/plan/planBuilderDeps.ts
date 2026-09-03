/**
 * The builder's dependencies — a named domain object held by `PlanBuilder`,
 * `SilentMeterPlanBuilder` and the wiring that constructs them (a module of its
 * own so the silent-meter pass can import it without a cycle through
 * `planBuilder.ts`).
 */
import type CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { PriceLevel } from '../price/priceLevels';
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

export type PlanBuilderDeps = {
  setCapacityInShortfall: (inShortfall: boolean) => void;
  /** Per-home dry-run posture — the same fact `shouldApplyPlan` consults
   * before actuating. */
  getCapacityDryRun: () => boolean;
  capacityGuard: CapacityGuard;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  // Producer-resolved: both current-hour flags from ONE combined-series build.
  getCurrentHourPriceLevel: () => PriceLevel;
  // Producer-resolved inferred curtailed-surplus term (kW, >= 0) for the surplus
  // allocator (zero-export homes); forwarded untouched to the per-device prep
  // pass. 0 is the whole of "nothing inferred" — see `homeScope`.
  getInferredSurplusKw: () => number;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot?: () => DailyBudgetUiPayload | null;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  getDynamicSoftLimitOverride?: () => number | null;
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
  // `DeferredDecorationBundle`. When absent (no smart tasks wired, e.g. tests),
  // the planner uses the identity bundle and stays entirely smart-task-agnostic.
  // This is the dependency inversion that keeps lib/plan free of lib/objectives.
  decorateDeferredObjectives?: (input: DeferredDecorationInput) => DeferredDecorationBundle;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};
