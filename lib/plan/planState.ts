import { RESTORE_COOLDOWN_MS } from './planConstants';
import type { PendingTargetObservationSource } from './planTypes';

export type PendingTargetCommandState = {
  capabilityId: string;
  desired: number;
  startedMs: number;
  lastAttemptMs: number;
  retryCount: number;
  nextRetryAtMs: number;
  lastObservedValue?: unknown;
  lastObservedSource?: PendingTargetObservationSource;
  lastObservedAtMs?: number;
};

export type PlanEngineState = {
  lastDeviceShedMs: Record<string, number>;
  lastDeviceRestoreMs: Record<string, number>;
  activationPenaltyLevelByDevice: Record<string, number>;
  activationAttemptStartedMsByDevice: Record<string, number>;
  activationAttemptSourceByDevice: Record<string, 'pels_restore' | 'tracked_step_up'>;
  activationAttemptStickReachedByDevice: Record<string, boolean>;
  headroomCardLastObservedKw: Record<string, number>;
  headroomCardLastStepDownMs: Record<string, number>;
  headroomCardCooldownUntilMs: Record<string, number>;
  headroomCardCooldownFromKw: Record<string, number>;
  headroomCardCooldownToKw: Record<string, number>;
  pendingSheds: Set<string>;
  pendingRestores: Set<string>;
  pendingBinaryCommands: Record<string, {
    capabilityId: 'onoff' | 'evcharger_charging';
    desired: boolean;
    startedMs: number;
  }>;
  pendingTargetCommands: Record<string, PendingTargetCommandState>;
  lastSheddingMs: number | null;
  lastOvershootMs: number | null;
  lastRestoreMs: number | null;
  lastPlannedShedIds: Set<string>;
  lastShedPlanMeasurementTs: number | null;
  lastSwapPlanMeasurementTs: Record<string, number>;
  inShortfall: boolean;
  swappedOutFor: Record<string, string>;
  pendingSwapTargets: Set<string>;
  pendingSwapTimestamps: Record<string, number>;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
  hourlyBudgetExhausted: boolean;
  wasOvershoot: boolean;
  overshootLogged: boolean;
};

export function createPlanEngineState(): PlanEngineState {
  return {
    lastDeviceShedMs: {},
    lastDeviceRestoreMs: {},
    activationPenaltyLevelByDevice: {},
    activationAttemptStartedMsByDevice: {},
    activationAttemptSourceByDevice: {},
    activationAttemptStickReachedByDevice: {},
    headroomCardLastObservedKw: {},
    headroomCardLastStepDownMs: {},
    headroomCardCooldownUntilMs: {},
    headroomCardCooldownFromKw: {},
    headroomCardCooldownToKw: {},
    pendingSheds: new Set<string>(),
    pendingRestores: new Set<string>(),
    pendingBinaryCommands: {},
    pendingTargetCommands: {},
    lastSheddingMs: null,
    lastOvershootMs: null,
    lastRestoreMs: null,
    lastPlannedShedIds: new Set<string>(),
    lastShedPlanMeasurementTs: null,
    lastSwapPlanMeasurementTs: {},
    inShortfall: false,
    swappedOutFor: {},
    pendingSwapTargets: new Set<string>(),
    pendingSwapTimestamps: {},
    restoreCooldownMs: RESTORE_COOLDOWN_MS,
    lastRestoreCooldownBumpMs: null,
    hourlyBudgetExhausted: false,
    wasOvershoot: false,
    overshootLogged: false,
  };
}
