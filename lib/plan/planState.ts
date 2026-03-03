import { RESTORE_COOLDOWN_MS } from './planConstants';

export type PlanEngineState = {
  lastDeviceShedMs: Record<string, number>;
  lastDeviceRestoreMs: Record<string, number>;
  headroomCardLastObservedKw: Record<string, number>;
  headroomCardCooldownUntilMs: Record<string, number>;
  headroomCardCooldownFromKw: Record<string, number>;
  headroomCardCooldownToKw: Record<string, number>;
  pendingSheds: Set<string>;
  pendingRestores: Set<string>;
  pendingBinaryCommands: Record<string, {
    capabilityId: 'onoff' | 'evcharger_charging';
    desired: boolean;
    startedMs: number;
    attempts: number;
  }>;
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
    headroomCardLastObservedKw: {},
    headroomCardCooldownUntilMs: {},
    headroomCardCooldownFromKw: {},
    headroomCardCooldownToKw: {},
    pendingSheds: new Set<string>(),
    pendingRestores: new Set<string>(),
    pendingBinaryCommands: {},
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
