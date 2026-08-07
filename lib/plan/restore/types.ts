import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../logging/logger';
import type { HeadroomReserve } from '../admission';
import type { DevicePlanDevice } from '../planTypes';
import type { SwapStateSnapshot } from '../swap';
import type { DeviceDiagnosticsRecorder } from '../../diagnostics/deviceDiagnosticsService';
import type { PowerTrackerState } from '../../power/tracker';

export type RestoreDeps = {
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  };
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
