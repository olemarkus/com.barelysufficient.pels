import { RESTORE_COOLDOWN_MS } from './planConstants';

export type PlanEngineState = {
  lastDeviceShedMs: Record<string, number>;
  lastDeviceRestoreMs: Record<string, number>;
  pendingSheds: Set<string>;
  pendingRestores: Set<string>;
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
};

export function createPlanEngineState(): PlanEngineState {
  return {
    lastDeviceShedMs: {},
    lastDeviceRestoreMs: {},
    pendingSheds: new Set<string>(),
    pendingRestores: new Set<string>(),
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
  };
}
