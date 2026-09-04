import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../logging/logger';
import type { HeadroomReserve, resolveRestoreDecisionPhase } from '../admission';
import type { DevicePlanDevice, ShedBehavior } from '../planTypes';
import type { SwapState, SwapStateSnapshot } from '../swap';
import type { DeviceDiagnosticsRecorder } from '../../diagnostics/deviceDiagnosticsService';
import type { PowerTrackerState } from '../../power/tracker';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
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
  /**
   * Whether this pass may actually admit, or is costing a hypothetical for the
   * cooldown preview. Always present: `{ kind: 'apply' }` is a decision, not an
   * absence, and it used to be spelled as an optional that eleven call sites
   * forwarded and one defaulted.
   */
  readonly admissionMode: RestoreAdmissionMode;
};

/**
 * The lane-scoped half: the devices currently on, and the swap executor closed
 * over them. Rebuilt per lane because restoring a device changes both.
 */
export type RestoreLane = {
  readonly onDevices: DevicePlanDevice[];
  readonly steppedSwapExecutor: SteppedSwapExecutor;
};

export type RestoreAdmissionMode =
  | { kind: 'apply' }
  | { kind: 'cooldown_preview'; holdReason: DeviceReason };

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

export type RestoreCooldownPreview = {
  holdReason: DeviceReason;
  selectedOne: boolean;
  appliesToAllCandidates: boolean;
  capacityAvailableKw: number;
  budgetAvailableKw: number | null;
};

/**
 * Result contract of the restore pass (`applyRestorePlan`), owned by
 * `lib/plan/restore`. Callers can rely on: `planDevices` carries every input
 * device with this cycle's restore/hold decisions applied; the per-axis
 * figures and `headroomReserves` are resolved exactly once per cycle by this
 * pass, and the downstream hold stage consumes them rather than re-resolving
 * (the reserve resolver advances arming state, so a second resolution is a
 * correctness bug, not just waste); the timing fields mirror this cycle's
 * `RestoreTiming`. Governing docs:
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
  // Hypothetical direct-admission state used only by the later set-temperature
  // lane while a global restore cooldown is active. Its ledger is separate
  // from the real cycle ledger, so selecting the next card never spends power
  // or creates executable intent.
  restoreCooldownPreview: RestoreCooldownPreview | null;
  restoredOneThisCycle: boolean;
  inCooldown: boolean;
  inRestoreCooldown: boolean;
  activeOvershoot: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs: number | null;
  shedCooldownTotalSec: number | null;
  restoreCooldownRemainingSec: number | null;
  restoreCooldownStartedAtMs: number | null;
  restoreCooldownTotalSec: number | null;
  inShedWindow: boolean;
  // `inShedWindow` is the OR of four causes and the downstream hold lane needs
  // them apart; `nowTs` is this pass's single clock read, which the ceiling
  // shortfall dates its recent-shed window against. Both already flow at runtime
  // through the `...effectiveTiming` spread in `applyRestorePlan` — declaring
  // them adds no computation and no second clock read.
  inStartupStabilization: boolean;
  nowTs: number;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
};
