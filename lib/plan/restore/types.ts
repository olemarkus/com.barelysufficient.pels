import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../logging/logger';
import type { HeadroomReserve, resolveRestoreDecisionPhase } from '../admission';
import type { DevicePlanDevice, ShedBehavior } from '../planTypes';
import type { SwapState, SwapStateSnapshot } from '../swap';
import type { DeviceDiagnosticsRecorder } from '../../diagnostics/deviceDiagnosticsService';
import type { PowerTrackerState } from '../../power/tracker';
import type { RestoreTiming } from './timing';
import type { PlanEngineState } from '../planState';
import type { SteppedSwapExecutor } from './helpers';

export type RestoreDeps = {
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  /** This build's capability-normalized configured shed floor per device —
   * resolved once by the builder (`resolveNormalizedShedFloors`); every
   * floor comparison in the restore/swap pass reads through it. */
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  deviceNameById?: ReadonlyMap<string, string>;
  logDebug: (...args: unknown[]) => void;
};

export type RestorePlanState = SwapStateSnapshot;

export type RestoreBatchState = {
  enabled: boolean;
  maxDevices: number;
  maxNeedKw: number;
  admittedCount: number;
  admittedNeedKw: number;
};

export type RestoreLoopState = {
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
};

/**
 * One restore pass, as every stage of it sees the pass.
 *
 * `applyRestorePlan` builds all of this on its first few lines and then carries
 * it from the first gate to the last. Before this type each stage redeclared
 * the subset it needed plus everything the stages below it needed — 46 inline
 * parameter objects across this directory, 356 declared properties of which
 * only 169 were ever read by the function declaring them. The rest were relay.
 *
 * Cycle-scoped, so what is NOT here matters: `onDevices` and the stepped-swap
 * executor are rebuilt per lane from a fresh device snapshot (a restore inside
 * the lane changes which devices are on), and the running
 * `availableHeadroom`/`restoredOneThisCycle` pair is `RestoreLoopState`. Those
 * three change during the pass; everything below does not.
 */
export type RestoreCycle = {
  readonly state: PlanEngineState;
  readonly deps: RestoreDeps;
  /** The pass's single mutable device index — stages read and write through it. */
  readonly deviceMap: Map<string, DevicePlanDevice>;
  readonly swapState: SwapState;
  readonly timing: RestoreTiming;
  readonly restoredThisCycle: Set<string>;
  /** Resolved exactly once per cycle — the resolver advances arming state. */
  readonly headroomReserves: readonly HeadroomReserve[];
  readonly batchState: RestoreBatchState;
  /**
   * Startup or runtime, resolved once from this cycle's rebuild trigger. It was
   * forwarded through thirteen of the bags and recomputed in several more, all
   * from the same `state.currentRebuildTrigger`.
   */
  readonly phase: ReturnType<typeof resolveRestoreDecisionPhase>;
};

/**
 * The lane-scoped half: the devices currently on, and the swap executor closed
 * over them. Rebuilt per lane because restoring a device changes both.
 */
export type RestoreLane = {
  readonly onDevices: DevicePlanDevice[];
  readonly steppedSwapExecutor: SteppedSwapExecutor;
};

export type RestoreDeviceTiming = Pick<RestoreTiming,
| 'activeOvershoot'
| 'inCooldown'
| 'inRestoreCooldown'
| 'inStartupStabilization'
| 'measurementTs'
| 'nowTs'
| 'restoreCooldownSeconds'
| 'restoreCooldownMs'
| 'shedCooldownRemainingSec'
| 'restoreCooldownRemainingSec'
| 'startupStabilizationRemainingSec'>;

/**
 * Result contract of the restore pass (`applyRestorePlan`), owned by
 * `lib/plan/restore`. Callers can rely on: `planDevices` carries every input
 * device with this cycle's restore/hold decisions applied; the per-axis
 * figures and `headroomReserves` are resolved exactly once per cycle by this
 * pass, and the downstream hold stage consumes them rather than re-resolving
 * (the reserve resolver advances arming state, so a second resolution is a
 * correctness bug, not just waste); `timing` is this cycle's effective
 * `RestoreTiming`, whole. Governing docs:
 * `notes/deferred-load-objectives/preemptive-power-reservation.md` (startup
 * reservations) and `notes/safe-pace-two-constraints.md` (the two admission
 * axes).
 */
export type RestorePlanResult = {
  planDevices: DevicePlanDevice[];
  stateUpdates: RestorePlanState;
  restoredThisCycle: Set<string>;
  // Post-pass NON-EXEMPT view (min of capacity and measured-exempt budget axes
  // from the per-axis ledger) — no longer the binding-axis scalar. Consumers:
  // batch throttle sizing and shed-temperature hold decisions; both conservative.
  availableHeadroom: number;
  // The underlying per-axis values (see headroomLedger.ts) — the hold lane
  // rebuilds a ledger from these so setpoint-shed devices admit per axis too.
  capacityAvailableKw: number;
  budgetAvailableKw: number | null;
  // This cycle's startup reservations, resolved ONCE by the restore pass (the
  // resolver advances arming state, so it must not run twice per cycle). The
  // hold lane admits setpoint-shed restores against the same reservations the
  // binary/stepped lanes honour — without this, the hold lane gave the promised
  // block away to any set_temperature restore.
  headroomReserves: readonly HeadroomReserve[];
  restoredOneThisCycle: boolean;
  /**
   * This cycle's EFFECTIVE timing — the one the pass decided from, with the
   * startup fields zeroed unless capacity is the binding source — carried whole
   * so the hold lane and diagnostics read the same object. It used to be
   * spread flat into the result beside the pass's outputs.
   */
  timing: RestoreTiming;
};
