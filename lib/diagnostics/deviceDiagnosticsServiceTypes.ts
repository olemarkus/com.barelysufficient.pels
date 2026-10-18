import type {
  DeviceDiagnosticsStarvationCountingCause,
  DeviceDiagnosticsStarvationPauseReason,
  SettingsUiDeviceDiagnosticsPayload,
} from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type { DeviceDiagnosticsStateStore } from './deviceDiagnosticsStateStore';
import type { StarvationTarget, StarvationUnmeasuredReason } from '../../packages/contracts/src/starvationRescue';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';

export type DeviceDiagnosticsBlockCause = 'not_blocked' | 'headroom' | 'cooldown_backoff';
export type DeviceDiagnosticsStarvationSuppressionState = 'counting' | 'paused' | 'none';

export type DeviceDiagnosticsStarvationResetReasonCode = 'device_no_longer_eligible';
/** One device's demand and starvation facts from a plan build, resolved by `lib/plan/planDiagnostics.ts`. */
export type DeviceDiagnosticsPlanObservation = {
  deviceId: string;
  name: string;
  demand: LiveDemandObservation;
  starvation: LiveStarvationObservation;
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
    penaltyLevel: number;
    nowTs: number;
  }
  | {
    kind: 'setback_failed';
    deviceId: string;
    previousPenaltyLevel: number;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_inactive';
    deviceId: string;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_by_shed';
    deviceId: string;
    penaltyLevel: number;
    elapsedMs: number;
    nowTs: number;
  }
  | {
    kind: 'attempt_closed_by_admission';
    deviceId: string;
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
  // The device's modelled draw when running, in kW. Prices a budget-denied hold
  // into the energy the daily-budget evidence is measured in.
  expectedPowerKw: number;
  // Cause-independent daily-budget pressure. True whenever this device has
  // unmet demand while the configured budget is below the planning ceiling over
  // the day (`isDailyBudgetBelowPlanningCeiling`), or any enabled budget when no
  // power limit is enabled.
  budgetPressureDenied: boolean;
  /** Temperature demand held specifically by daily pace, while physically short of target. */
  budgetUnservedDenied: boolean;
  /** Observed physical recovery; commanding the full target is not sufficient. */
  budgetDemandRecovered: boolean;
};


/**
 * Whether the held-back list can show this device. Resolved in the producer
 * (`lib/plan/planDiagnostics.ts`) so the held-back widget can say why a device
 * PELS limits for power is not listed, in the device's own terms.
 *
 * - `off_list`: not the widget's business: PELS is not limiting it for power,
 *   or something other than PELS holds it (the owner's hold, its smart task's
 *   deferral).
 * - `candidate`: starvation measures it, so it is listed once held back long
 *   enough (or not at all while it sits at its target).
 * - a {@link StarvationUnmeasuredReason}: PELS limits it, and starvation cannot
 *   measure it, for that reason.
 */
export type HeldBackScope = 'off_list' | 'candidate' | StarvationUnmeasuredReason;

export type LiveStarvationObservation = {
  eligibleForStarvation: boolean;
  heldBackScope: HeldBackScope;
  currentTemperatureC: number | null;
  // The normal target the device is measured against: its mode temperature, or
  // a charger's target battery level. Null when the device has none to read
  // this cycle, which makes the observation invalid.
  intendedTarget: StarvationTarget | null;
  // The effective target PELS is currently COMMANDING a temperature device
  // toward (the applied/held setpoint, quantized to the device's target step).
  // A thermostat is starved only when PELS holds this BELOW its intended
  // temperature — i.e. PELS
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
  suppressionState: DeviceDiagnosticsStarvationSuppressionState;
  countingCause: DeviceDiagnosticsStarvationCountingCause | null;
  pauseReason: DeviceDiagnosticsStarvationPauseReason | null;
  // True when PELS is holding the device below its intended/mode target — the
  // entry signal for starvation. For a temperature device, either PELS commands
  // a lowered setpoint (`commandedTargetC` below the intended temperature by at
  // least the target step) OR PELS sheds the device by turning it OFF while its
  // temperature sits below the intended target. For a charger, PELS limits it
  // (paused, or held below its top step) while the car's known level is below
  // the target battery level. All of these are PELS actively limiting the
  // device; a device PELS commands in full (`keep`) is never below. Resolved ONCE in the producer
  // (`lib/plan/planDiagnostics.ts`) so the starvation clock and the
  // demand/censoring counters can never diverge.
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
};

/**
 * Home-level censoring evidence for one local day, read from persisted
 * per-device aggregates. Budget denial is integrated over every continuously
 * observed unmet-demand span while the configured budget is below sustainable
 * capacity; it does not depend on an instantaneous planner reason label.
 */
export type DeviceDiagnosticsDaySuppressionTotals = {
  targetDeficitMs: number;
  blockedByHeadroomMs: number;
  budgetUnservedKwh?: number;
  budgetDeniedKwh: number;
  budgetDeniedMs: number;
  /** True when the continuous budget-denial signal was actually observed. */
  budgetDenialObserved: boolean;
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
