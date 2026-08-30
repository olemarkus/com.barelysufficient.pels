import type { ActivationAttemptSource } from '../plan/admission';
import type {
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type { DeviceDiagnosticsStateStore } from './deviceDiagnosticsStateStore';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';

export type DeviceDiagnosticsBlockCause = 'not_blocked' | 'headroom' | 'cooldown_backoff';
export type DeviceDiagnosticsStarvationSuppressionState = 'counting' | 'paused' | 'none';

export type DeviceDiagnosticsStarvationResetReasonCode = 'device_no_longer_eligible';
export type DeviceDiagnosticsPlanObservation = {
  deviceId: string;
  name: string;
  includeDemandMetrics: boolean;
  unmetDemand: boolean;
  blockCause: DeviceDiagnosticsBlockCause;
  targetDeficitActive: boolean;
  desiredStateSummary: string;
  appliedStateSummary: string;
  eligibleForStarvation: boolean;
  currentTemperatureC: number | null;
  intendedNormalTargetC: number | null;
  // The effective target PELS is currently COMMANDING the device toward (the
  // applied/held setpoint, quantized to the device's target step). A device is
  // starved only when PELS holds this BELOW `intendedNormalTargetC` — i.e. PELS
  // is actively limiting the device, not merely waiting for it to reach a target
  // it is already commanding in full.
  commandedTargetC: number | null;
  targetStepC: number | null;
  // True when PELS is shedding this temperature device by commanding it OFF
  // (`plannedState === 'shed'` with the `turn_off` shed behavior). A turn_off
  // shed cuts power without lowering a setpoint, so the commanded-vs-intended
  // target check alone cannot see it; this flag carries the "PELS holds the
  // device off" signal so a below-target turn_off shed still counts as
  // suppression. A device the USER turned off (PELS not shedding it) has
  // `plannedState !== 'shed'` and never sets this.
  pelsCommandsTurnOffShed: boolean;
  // PELS is holding this device below its intended/mode target — a lowered
  // commanded setpoint OR a turn_off shed while the room sits below target.
  // Resolved ONCE in the producer (`lib/plan/planDiagnostics.ts`) so the
  // starvation clock and the demand/censoring counters can never diverge.
  pelsHoldsBelowTarget: boolean;
  // The device's modelled draw when running, in kW. Prices a budget-denied hold
  // into the energy the daily-budget evidence is measured in.
  expectedPowerKw: number;
  suppressionState: DeviceDiagnosticsStarvationSuppressionState;
  countingCause: DeviceDiagnosticsStarvationCountingCause | null;
  pauseReason: DeviceDiagnosticsStarvationPauseReason | null;
};

type DeviceDiagnosticsControlEventBase = {
  deviceId: string;
  name?: string;
  nowTs?: number;
};

export type DeviceDiagnosticsTrackedTransitionReconciliation =
  | 'startup'
  | 'snapshot_refresh'
  | 'post_actuation';

export type DeviceDiagnosticsControlEvent =
  | (DeviceDiagnosticsControlEventBase & {
    kind: 'pels_shed' | 'pels_restore';
  })
  | (DeviceDiagnosticsControlEventBase & {
    kind: 'tracked_usage_rise' | 'tracked_usage_drop';
    fromKw: number;
    toKw: number;
    reconciliation?: DeviceDiagnosticsTrackedTransitionReconciliation;
  });

export type DeviceDiagnosticsBackoffTransition =
  | {
    kind: 'attempt_started';
    deviceId: string;
    source: ActivationAttemptSource;
    penaltyLevel: number;
    nowTs: number;
  }
  | {
    kind: 'setback_failed';
    deviceId: string;
    source: ActivationAttemptSource | null;
    previousPenaltyLevel: number;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_inactive';
    deviceId: string;
    source: ActivationAttemptSource | null;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_by_shed';
    deviceId: string;
    source: ActivationAttemptSource | null;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_by_admission';
    deviceId: string;
    source: ActivationAttemptSource | null;
    previousPenaltyLevel: number;
    penaltyLevel: 0;
    elapsedMs: number;
    nowTs: number;
  };

export type DeviceDiagnosticsRecorder = {
  observePlanSample: (params: {
    observations: DeviceDiagnosticsPlanObservation[];
    nowTs?: number;
  }) => void;
  recordControlEvent: (event: DeviceDiagnosticsControlEvent) => void;
  recordActivationTransition: (transition: DeviceDiagnosticsBackoffTransition, params: {
    name?: string;
  }) => void;
  getUiPayload: (nowTs?: number) => SettingsUiDeviceDiagnosticsPayload;
};

export type LiveDemandObservation = {
  includeDemandMetrics: boolean;
  unmetDemand: boolean;
  blockCause: DeviceDiagnosticsBlockCause;
  targetDeficitActive: boolean;
  desiredStateSummary: string;
  appliedStateSummary: string;
};


export type LiveStarvationObservation = {
  eligibleForStarvation: boolean;
  currentTemperatureC: number | null;
  intendedNormalTargetC: number | null;
  commandedTargetC: number | null;
  targetStepC: number | null;
  pelsCommandsTurnOffShed: boolean;
  suppressionState: DeviceDiagnosticsStarvationSuppressionState;
  countingCause: DeviceDiagnosticsStarvationCountingCause | null;
  pauseReason: DeviceDiagnosticsStarvationPauseReason | null;
  // True when PELS is holding the device below its intended/mode target — the
  // entry signal for starvation. Either PELS commands a lowered setpoint
  // (`commandedTargetC < intendedNormalTargetC` by at least the target step) OR
  // PELS sheds the device by turning it OFF while its temperature sits below the
  // intended target. Both are PELS actively limiting the device; a device PELS
  // commands in full (`keep`) is never below.
  pelsHoldsBelowTarget: boolean;
};

export type StarvationEvaluation = {
  validObservation: boolean;
  // PELS is actively limiting the device (a real capacity/budget/shortfall
  // suppression) AND commanding it below its intended/mode target.
  counting: boolean;
  // Starvation may ENTER or keep ACCUMULATING: PELS holds the device below its
  // mode target right now. A device PELS commands in full (`keep`) never starves,
  // regardless of how far its physical temperature sits below target.
  entryQualified: boolean;
  // PELS no longer holds the device below its mode target — clear the episode.
  clearQualified: boolean;
  pauseReason: DeviceDiagnosticsStarvationPauseReason;
};

export type LiveStarvationState = {
  isStarved: boolean;
  pendingEntryStartedAt?: number;
  clearQualifiedStartedAt?: number;
  starvedAccumulatedMs: number;
  starvationEpisodeStartedAt?: number;
  starvationLastResumedAt?: number;
  starvationCause: DeviceDiagnosticsStarvationCountingCause | null;
  starvationPauseReason: DeviceDiagnosticsStarvationPauseReason | null;
  // Day-scoped accrual of latched, `daily_budget`-attributed counting time — the
  // magnitude behind the day-close damage verdict the weather advisor reads. The
  // current slot belongs to `deniedBudgetDayKey`; the first CONTINUOUS
  // observation span crossing local midnight rolls it into the previous-day
  // slot. Rolled-slot presence therefore implies the boundary was witnessed by
  // an unbroken span; a sample gap across midnight wipes both slots instead
  // (state at the boundary is unknowable, and unprovable means not damage).
  // In-memory only, reset with the episode: a served hold leaves nothing behind.
  deniedBudgetDayMs: number;
  deniedBudgetDayKey?: string;
  deniedBudgetPrevDayMs?: number;
  deniedBudgetPrevDayKey?: string;
  // Whether the DAILY BUDGET was the cause of the last counting slice accrued
  // into the current-day slot. Tracked per slice because the live
  // `starvationCause` is mutable — a zero-length span at the first post-midnight
  // observation refreshes it before the crossing span rolls, and the budget
  // RESETTING at midnight makes exactly that flip likely.
  deniedBudgetDayCauseWasBudget?: boolean;
  // The per-slice cause flag above, snapshotted at the roll: whether the budget
  // was the cause in force when the previous day CLOSED. The 00:05 join gates
  // the rolled slot on this, never on the live cause.
  deniedBudgetPrevDayClosedByBudget?: boolean;
};

/**
 * Home-level censoring evidence for one local day. The legacy `*Ms` totals come
 * from the persisted per-device aggregates; the `budgetDenied*` pair is joined
 * from LIVE episode state at read time and is only present when the local
 * midnight closing `dateKey` was witnessed by an unbroken observation stream —
 * present-with-zero means "watched, nothing denied", absent means "no witness"
 * (restart, sample gap, or a day that predates this evidence).
 */
export type DeviceDiagnosticsDaySuppressionTotals = {
  targetDeficitMs: number;
  blockedByHeadroomMs: number;
  budgetDeniedKwh?: number;
  budgetDeniedMs?: number;
  // Set when a verdict-capable build rolled this day up WITHOUT a witnessed
  // verdict (restart or sample gap across its midnight). Blocks the legacy
  // hold-time fallback: an unwitnessed modern day is "unprovable, so not
  // damage", never "apply the pre-verdict semantics". Absent on records old
  // builds wrote — only those may use the legacy counters.
  budgetDeniedUnwitnessed?: true;
};

export type LiveDeviceDiagnostics = {
  name: string;
  lastObservedTs?: number;
  lastObservationBatchId?: number;
  lastObservation?: LiveDemandObservation;
  lastStarvationObservation?: LiveStarvationObservation;
  // The device's modelled draw from the most recent sample — prices a latched
  // episode's denied time into kWh at the day-close join.
  lastExpectedPowerKw?: number;
  openShedTs?: number;
  openRestoreTs?: number;
  currentPenaltyLevel: number;
  starvation: LiveStarvationState;
};

export type DeviceDiagnosticsServiceDeps = {
  diagnosticsStateStore: DeviceDiagnosticsStateStore;
  getTimeZone: () => string;
  isDebugEnabled?: () => boolean;
  structuredLog?: Pick<PinoLogger, 'info' | 'error'>;
  debugStructured?: StructuredDebugEmitter;
};
