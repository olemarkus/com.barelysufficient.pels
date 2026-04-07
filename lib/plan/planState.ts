import { RESTORE_COOLDOWN_MS } from './planConstants';
import type {
  PendingTargetCommandStatus,
  PendingTargetObservationSource,
} from './planTypes';

export type ActivationAttemptSource = 'pels_restore' | 'tracked_step_up';

export type PendingTargetCommandState = {
  capabilityId: string;
  desired: number;
  startedMs: number;
  lastAttemptMs: number;
  retryCount: number;
  nextRetryAtMs: number;
  status: PendingTargetCommandStatus;
  lastObservedValue?: unknown;
  lastObservedSource?: PendingTargetObservationSource;
  lastObservedAtMs?: number;
  lastWaitingLogAtMs?: number;
};

export type ActivationAttemptState = {
  penaltyLevel?: number;
  lastSetbackMs?: number;
  startedMs?: number;
  source?: ActivationAttemptSource;
  stickReached?: boolean;
};

export type HeadroomCardState = {
  lastObservedKw?: number;
  lastStepDownMs?: number;
  cooldownUntilMs?: number;
  cooldownFromKw?: number;
  cooldownToKw?: number;
};

export type SwapEntry = {
  swappedOutFor?: string;
  pendingTarget?: boolean;
  timestamp?: number;
  lastPlanMeasurementTs?: number;
};

export type PlanEngineState = {
  lastDeviceShedMs: Record<string, number>;
  lastDeviceRestoreMs: Record<string, number>;
  activationAttemptByDevice: Record<string, ActivationAttemptState>;
  headroomCardByDevice: Record<string, HeadroomCardState>;
  pendingSheds: Set<string>;
  pendingRestores: Set<string>;
  pendingBinaryCommands: Record<string, {
    capabilityId: 'onoff' | 'evcharger_charging';
    desired: boolean;
    startedMs: number;
    pendingMs?: number;
    lastObservedValue?: boolean | string;
    lastObservedSource?: PendingTargetObservationSource;
    lastObservedAtMs?: number;
  }>;
  pendingTargetCommands: Record<string, PendingTargetCommandState>;
  lastInstabilityMs: number | null;
  lastRecoveryMs: number | null;
  lastRestoreMs: number | null;
  lastPlannedShedIds: Set<string>;
  lastShedPlanMeasurementTs: number | null;
  swapByDevice: Record<string, SwapEntry>;
  inShortfall: boolean;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
  startupRestoreBlockedUntilMs: number | null;
  currentRebuildReason: string | null;
  hourlyBudgetExhausted: boolean;
  wasOvershoot: boolean;
  overshootLogged: boolean;
  overshootStartedMs: number | null;
  lastOvershootEscalationMs: number | null;
  lastOvershootMitigationMs: number | null;
  steppedRestoreRejectedByDevice: Record<string, {
    requestedStepId: string;
    lowestNonZeroStepId: string;
    shedDeviceCount: number;
  }>;
  keepInvariantShedBlockedByDevice: Record<string, {
    desiredStepId: string;
    lowestNonZeroStepId: string;
  }>;
};

export function createPlanEngineState(): PlanEngineState {
  return {
    lastDeviceShedMs: {},
    lastDeviceRestoreMs: {},
    activationAttemptByDevice: {},
    headroomCardByDevice: {},
    pendingSheds: new Set<string>(),
    pendingRestores: new Set<string>(),
    pendingBinaryCommands: {},
    pendingTargetCommands: {},
    lastInstabilityMs: null,
    lastRecoveryMs: null,
    lastRestoreMs: null,
    lastPlannedShedIds: new Set<string>(),
    lastShedPlanMeasurementTs: null,
    swapByDevice: {},
    inShortfall: false,
    restoreCooldownMs: RESTORE_COOLDOWN_MS,
    lastRestoreCooldownBumpMs: null,
    startupRestoreBlockedUntilMs: null,
    currentRebuildReason: null,
    hourlyBudgetExhausted: false,
    wasOvershoot: false,
    overshootLogged: false,
    overshootStartedMs: null,
    lastOvershootEscalationMs: null,
    lastOvershootMitigationMs: null,
    steppedRestoreRejectedByDevice: {},
    keepInvariantShedBlockedByDevice: {},
  };
}
